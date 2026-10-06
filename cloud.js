'use strict';
/* クラウド連携（Firebase Authentication + Cloud Firestore）
 * - ログイン：メール＋パスワード（アカウントは管理者が Firebase コンソールで作成）
 * - マスター（品番 parts／写真 photos）は Firestore に保存し、各タブレットの IndexedDB に「キャッシュ」する
 * - 照合はキャッシュだけを見て動くので、オフラインでも使える
 * - マスターの追加・変更・削除ができるのは管理者だけ（セキュリティルールで強制）
 * ※ dbPut / dbAll / mastersOf などは app.js 側で定義（呼ばれる時には使える状態になっています）
 */

const PHOTO_MAX_SIDE = 800;          // 写真の長辺(px)
const PHOTO_QUALITY = 0.8;           // JPEG 品質
const PHOTO_MAX_BYTES = 400 * 1024;  // 1枚の上限
const PHOTOS_PER_PART = 10;          // 1品番に登録できる写真の上限（セキュリティルールは30枚まで許可）
const POINTS_PER_PHOTO = 20;         // 1枚のマスター写真に登録できる検査ポイントの上限
const WRITE_TIMEOUT = 20000;         // 書き込みの待ち時間(ms)
const PHOTO_WRITE_TIMEOUT = 90000;   // 写真の書き込みは大きいので長めに待つ(ms)

const cloud = {
  configured: false,
  app: null, auth: null, db: null,
  user: null, role: null,           // role: 'admin' | 'member' | null
  status: { kind: 'idle', text: '' }, // kind: idle | offline | syncing | ok | error
  lastSync: 0,
  onStatus: () => {},               // 同期の状態が変わった
  onData: () => {},                 // 端末内のマスター（キャッシュ）が変わった
  onUser: () => {},                 // ログイン状態・権限が変わった
  _unsub: null, _queue: Promise.resolve(), _photoQueue: Promise.resolve(), _lastParts: null, _retryTimer: null,

  isAdmin() { return this.role === 'admin'; },

  /* ---------- 初期化 ---------- */
  init() {
    const c = window.FIREBASE_CONFIG || {};
    this.configured = !!(window.FB && c.apiKey && c.projectId && !/ここに貼り付け/.test(c.apiKey + c.projectId));
    if (!this.configured) return false;
    const F = window.FB;
    this.app = F.initializeApp(c);
    this.auth = F.initializeAuth(this.app, { persistence: F.indexedDBLocalPersistence });
    this.db = F.initializeFirestore(this.app, { ignoreUndefinedProperties: true });
    F.onAuthStateChanged(this.auth, u => this._onAuth(u));
    window.addEventListener('online', () => this._wake());
    window.addEventListener('offline', () => this._setStatus('offline', 'オフライン（端末内のマスターで照合できます）'));
    return true;
  },

  async signIn(email, password) {
    return window.FB.signInWithEmailAndPassword(this.auth, email.trim(), password);
  },
  async signOut() {
    await window.FB.signOut(this.auth);
  },

  async _onAuth(u) {
    this._stopSync();
    this.user = u; this.role = null;
    if (!u) { this._setStatus('idle', ''); this.onUser('out'); return; }
    const key = 'role:' + (u.email || '').toLowerCase();
    this.role = await kvGet(key, null);       // まず前回の結果（オフラインでも動くように）
    this.onUser('in');
    const r = await this._fetchRole(u);
    if (r === 'denied') {                     // 名簿に載っていない → 端末内のマスターも消す
      await this._wipeCache();
      this.role = null; this.onUser('denied');
      return;
    }
    if (r) { this.role = r; await kvSet(key, r); this.onUser('role'); }
    this._startSync();
  },

  /** 名簿(members)から自分の権限を取得。'admin' | 'member' | 'denied' | null(通信できず) */
  async _fetchRole(u) {
    const F = window.FB;
    try {
      const s = await F.getDoc(F.doc(this.db, 'members', (u.email || '').toLowerCase()));
      if (!s.exists()) return 'denied';
      return s.data().role === 'admin' ? 'admin' : 'member';
    } catch (e) {
      console.warn('権限の確認ができませんでした', e);
      return null;
    }
  },

  async _wipeCache() {
    await dbClear('cparts'); await dbClear('cmasters');
    this.onData();
  },

  /* ---------- 同期（クラウド → 端末内キャッシュ） ---------- */
  _setStatus(kind, text) {
    this.status = { kind, text };
    this.onStatus(this.status);
  },
  _startSync() {
    const F = window.FB;
    this._setStatus(navigator.onLine ? 'syncing' : 'offline', navigator.onLine ? '同期中…' : 'オフライン（端末内のマスターで照合できます）');
    this._unsub = F.onSnapshot(F.collection(this.db, 'parts'), { includeMetadataChanges: true }, snap => {
      const parts = snap.docs.map(d => ({
        partNo: d.id, pending: d.metadata.hasPendingWrites, ...d.data()
      }));
      const removed = snap.docChanges().filter(c => c.type === 'removed').map(c => c.doc.id);
      this._lastParts = { parts, removed, full: !snap.metadata.fromCache };
      this._enqueue(() => this._apply(this._lastParts));
    }, err => {
      console.error(err);
      const denied = err && err.code === 'permission-denied';
      this._setStatus('error', denied ? '権限がありません（管理者に連絡してください）' : '同期できません。端末内のマスターで照合できます');
    });
  },
  _stopSync() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    clearTimeout(this._retryTimer);
    this._lastParts = null;
  },
  _enqueue(fn) { this._queue = this._queue.then(fn).catch(e => console.error(e)); },
  _wake() {
    if (this._lastParts) this._enqueue(() => this._apply(this._lastParts));
  },
  /** 手動の再同期 */
  resync() { this._wake(); },

  async _apply({ parts, removed, full }) {
    let changed = false;
    const localParts = await dbAll('cparts');
    const nos = new Set(parts.map(p => p.partNo));
    // 消された品番を端末からも消す（全件取得できたときは、載っていないものも消す）
    const gone = new Set(removed);
    if (full) localParts.forEach(lp => { if (!nos.has(lp.partNo)) gone.add(lp.partNo); });
    for (const no of gone) {
      if (nos.has(no)) continue;
      if (localParts.find(lp => lp.partNo === no) || (await mastersOf(no)).length) { await this._dropLocalPart(no); changed = true; }
    }
    // 品番の情報を更新し、足りない写真を集める
    const todo = [];       // ダウンロードする写真
    for (const p of parts) {
      const rec = {
        partNo: p.partNo, name: p.name || '', photoIds: p.photoIds || [],
        createdAt: p.createdAt || 0, updatedAt: p.updatedAt || 0
      };
      if (typeof p.threshold === 'number') rec.threshold = p.threshold;
      if (p.points && typeof p.points === 'object') rec.points = p.points;     // 検査ポイント { 写真ID: [ポイント…] }
      const old = localParts.find(lp => lp.partNo === p.partNo);
      if (!old || JSON.stringify(old) !== JSON.stringify(rec)) { await dbPut('cparts', rec); changed = true; }
      if (p.pending) continue;      // 書き込み確定前の写真は、確定してから取りに行く
      const have = await mastersOf(p.partNo);
      const haveIds = new Set(have.map(m => m.id));
      const want = new Set(rec.photoIds);
      for (const m of have) if (!want.has(m.id)) { await dbDel('cmasters', m.id); changed = true; }
      for (const id of rec.photoIds) if (!haveIds.has(id)) todo.push({ id, partNo: p.partNo });
    }
    if (changed) this.onData();
    // 写真をダウンロード
    let done = 0, failed = 0;
    for (const t of todo) {
      if (!navigator.onLine) { failed++; continue; }
      this._setStatus('syncing', `同期中… 写真 ${done + 1}/${todo.length}`);
      try { if (await this._fetchPhoto(t)) { changed = true; this.onData(); } else failed++; }
      catch (e) { console.warn('写真の取得に失敗', e); failed++; }
      done++;
    }
    clearTimeout(this._retryTimer);
    if (failed) {
      this._retryTimer = setTimeout(() => this._wake(), 30000);
      this._setStatus(navigator.onLine ? 'error' : 'offline', navigator.onLine ? '一部の写真を取得できませんでした（自動で再試行します）' : 'オフライン（端末内のマスターで照合できます）');
    } else if (full) {
      this.lastSync = Date.now();
      this._setStatus('ok', '同期済み ' + hhmm(this.lastSync));
    } else {
      this._setStatus(navigator.onLine ? 'syncing' : 'offline', navigator.onLine ? '同期中…' : 'オフライン（端末内のマスターで照合できます）');
    }
  },

  async _dropLocalPart(partNo) {
    await dbDel('cparts', partNo);
    for (const m of await mastersOf(partNo)) await dbDel('cmasters', m.id);
  },

  async _fetchPhoto({ id, partNo }) {
    const F = window.FB;
    const s = await F.getDoc(F.doc(this.db, 'photos', id));
    if (!s.exists()) return false;
    const d = s.data();
    const blob = new Blob([d.jpeg.toUint8Array()], { type: 'image/jpeg' });
    await dbPut('cmasters', { id, partNo, blob, createdAt: d.createdAt || 0 });
    return true;
  },

  /* ---------- 管理者の操作（端末 → クラウド） ---------- */
  _needAdmin() {
    if (!this.isAdmin()) throw new Error('管理者だけが操作できます');
    if (!navigator.onLine) throw new Error('オフラインのため変更できません。ネットに繋いでから操作してください');
  },
  _timeout(p, ms = WRITE_TIMEOUT) {
    let t;
    const limit = new Promise((_, rej) => { t = setTimeout(() => { const e = new Error('通信できませんでした。電波を確認して、もう一度お試しください'); e.code = 'app/timeout'; rej(e); }, ms); });
    return Promise.race([p, limit]).finally(() => clearTimeout(t));
  },
  _by() { return (this.user && this.user.email) || ''; },

  async createPart(partNo, name) {
    this._needAdmin();
    const F = window.FB, ref = F.doc(this.db, 'parts', partNo);
    if ((await this._timeout(F.getDoc(ref))).exists()) throw new Error('その品番はすでにあります');
    const now = Date.now();
    await this._timeout(F.setDoc(ref, { name, photoIds: [], createdAt: now, updatedAt: now, updatedBy: this._by() }));
  },
  async updatePart(partNo, fields) {   // fields: { name } / { threshold: n } / { threshold: null }（標準に戻す）
    this._needAdmin();
    const F = window.FB, data = { updatedAt: Date.now(), updatedBy: this._by() };
    if ('name' in fields) data.name = fields.name;
    if ('threshold' in fields) data.threshold = fields.threshold === null ? F.deleteField() : fields.threshold;
    await this._timeout(F.updateDoc(F.doc(this.db, 'parts', partNo), data));
  },
  async deletePart(partNo) {
    this._needAdmin();
    const F = window.FB, ref = F.doc(this.db, 'parts', partNo);
    const s = await this._timeout(F.getDoc(ref));
    const ids = s.exists() ? (s.data().photoIds || []) : [];
    const b = F.writeBatch(this.db);
    ids.forEach(id => b.delete(F.doc(this.db, 'photos', id)));
    b.delete(ref);
    await this._timeout(b.commit());
    await this._dropLocalPart(partNo); this.onData();
  },
  /** blob: すでに縮小・圧縮済みの JPEG
   *  失敗したときは、どの段階で失敗したか（e.phase）を付けて投げる。写真は1枚ずつ順番に保存する */
  addPhoto(partNo, blob, w, h) {
    const run = this._photoQueue.then(() => this._addPhoto(partNo, blob, w, h));
    this._photoQueue = run.catch(() => {});
    return run;
  },
  async _addPhoto(partNo, blob, w, h) {
    let phase = '準備';
    try {
      this._needAdmin();
      if (blob.size > PHOTO_MAX_BYTES) throw new Error('写真が大きすぎます（' + Math.round(blob.size / 1024) + 'KB）');
      const F = window.FB, pref = F.doc(this.db, 'parts', partNo);
      phase = '品番の確認';
      const ps = await this._timeout(F.getDoc(pref));
      if (!ps.exists()) throw new Error('品番が見つかりません');
      if ((ps.data().photoIds || []).length >= PHOTOS_PER_PART) throw new Error(`1つの品番に登録できる写真は${PHOTOS_PER_PART}枚までです`);
      phase = '写真データの読み込み';
      const ref = F.doc(F.collection(this.db, 'photos')), now = Date.now();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      phase = 'クラウドへの保存';
      const b = F.writeBatch(this.db);
      b.set(ref, { partNo, jpeg: F.Bytes.fromUint8Array(bytes), w, h, createdAt: now, createdBy: this._by() });
      b.update(pref, { photoIds: F.arrayUnion(ref.id), updatedAt: now, updatedBy: this._by() });
      await this._timeout(b.commit(), PHOTO_WRITE_TIMEOUT);
      phase = '端末内への保存';
      try { await dbPut('cmasters', { id: ref.id, partNo, blob, createdAt: now }); this.onData(); }
      catch (e) { console.warn('端末内への保存に失敗（クラウドには保存済み。同期で取得し直します）', e); this._wake(); }
      return ref.id;
    } catch (e) {
      if (e && typeof e === 'object' && !e.phase) e.phase = phase;
      throw e;
    }
  },
  async deletePhoto(partNo, id) {
    this._needAdmin();
    const F = window.FB, b = F.writeBatch(this.db);
    b.delete(F.doc(this.db, 'photos', id));
    const upd = { photoIds: F.arrayRemove(id), updatedAt: Date.now(), updatedBy: this._by() };
    upd['points.' + id] = F.deleteField();            // その写真の検査ポイントも一緒に消す
    b.update(F.doc(this.db, 'parts', partNo), upd);
    await this._timeout(b.commit());
    await dbDel('cmasters', id); this.onData();
  },
  /** 1枚のマスター写真の検査ポイントを保存する。list が空なら削除。
   *  list: [{ name, x, y, w, h, must, th? }]（x,y,w,h は 0〜1 の比率） */
  async setPoints(partNo, photoId, list) {
    this._needAdmin();
    if (list.length > POINTS_PER_PHOTO) throw new Error(`検査ポイントは1枚の写真に${POINTS_PER_PHOTO}個までです`);
    const F = window.FB, upd = { updatedAt: Date.now(), updatedBy: this._by() };
    upd['points.' + photoId] = list.length ? list : F.deleteField();
    await this._timeout(F.updateDoc(F.doc(this.db, 'parts', partNo), upd));
    const cur = await dbGet('cparts', partNo);          // この端末のキャッシュにもすぐ反映
    if (cur) {
      cur.points = Object.assign({}, cur.points);
      if (list.length) cur.points[photoId] = list; else delete cur.points[photoId];
      await dbPut('cparts', cur); this.onData();
    }
  }
};

function hhmm(ts) {
  const d = new Date(ts), p = x => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** ログインエラーを日本語にする */
function authErrorText(e) {
  const c = (e && e.code) || '';
  if (/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c)) return 'メールアドレスかパスワードが違います';
  if (c === 'auth/invalid-email') return 'メールアドレスの形式が正しくありません';
  if (c === 'auth/user-disabled') return 'このアカウントは無効にされています';
  if (c === 'auth/too-many-requests') return '失敗が続いたため一時的に制限されています。しばらく待ってからお試しください';
  if (c === 'auth/network-request-failed') return '通信できません。ネットに繋いでからお試しください';
  return 'ログインできませんでした（' + (c || (e && e.message) || '不明なエラー') + '）';
}
