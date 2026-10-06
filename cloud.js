'use strict';
/* クラウド連携（Firebase Authentication + Cloud Firestore）
 *
 * ここはクラウドとのやりとりだけを担当します。画面や端末内の保存は app.js 側です。
 *   config/access    … 許可リスト（管理者UID・照合ユーザーUID）。コンソールで編集
 *   config/settings  … 全タブレット共通の標準しきい値
 *   parts/{id}       … 品番（品名・しきい値・マスター写真のID一覧）
 *   masters/{id}     … マスター写真 1枚（JPEG をバイナリで保存。Cloud Storage は使いません）
 */
const Cloud = (() => {
  const cfg = window.FIREBASE_CONFIG || {};
  let auth = null, db = null;

  const configured = () => !!(cfg.apiKey && cfg.projectId && !/ここに|PASTE/i.test(cfg.apiKey + cfg.projectId));
  const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) =>
    setTimeout(() => rej(Object.assign(new Error('通信がタイムアウトしました'), { code: 'timeout' })), ms))]);
  const ts = () => firebase.firestore.FieldValue.serverTimestamp();
  /** 品番 → ドキュメントID（「/」や「.」「_」を含んでも安全なように変換） */
  const partDocId = no => encodeURIComponent(no).replace(/[.!~*'()_]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

  function init() {
    firebase.initializeApp(cfg);
    auth = firebase.auth();
    db = firebase.firestore();
    const emu = window.FIREBASE_EMULATOR;           // 開発用の動作確認でだけ使います
    if (emu) {
      auth.useEmulator(`http://${emu.host}:${emu.authPort}`, { disableWarnings: true });
      db.useEmulator(emu.host, emu.firestorePort);
    } else {
      db.settings({ experimentalAutoDetectLongPolling: true });  // 社内ネットワークなどでも繋がりやすくする
    }
  }

  /* ---- ログイン ---- */
  const login = (email, password) => timeout(auth.signInWithEmailAndPassword(email, password), 20000);
  const logout = () => auth.signOut();
  const onAuth = fn => auth.onAuthStateChanged(fn);
  const user = () => auth && auth.currentUser;

  /** 'admin' | 'member' | 'none'（許可されていない）。通信できないときは例外 */
  async function fetchRole(uid) {
    try {
      const s = await timeout(db.doc('config/access').get({ source: 'server' }), 15000);
      if (!s.exists) return 'none';
      const d = s.data() || {};
      if ((d.admins || []).includes(uid)) return 'admin';
      if ((d.members || []).includes(uid)) return 'member';
      return 'none';
    } catch (e) {
      if (e.code === 'permission-denied') return 'none';
      throw e;
    }
  }

  /* ---- 読み取り（全ユーザー） ---- */
  async function fetchSettings() {
    const s = await timeout(db.doc('config/settings').get({ source: 'server' }), 15000);
    return s.exists ? s.data() : null;
  }
  async function fetchParts() {
    const q = await timeout(db.collection('parts').get({ source: 'server' }), 30000);
    return q.docs.map(d => {
      const x = d.data();
      return {
        partNo: x.partNo, name: x.name || '', masterIds: Array.isArray(x.masterIds) ? x.masterIds : [],
        threshold: typeof x.threshold === 'number' ? x.threshold : undefined,
        updatedAt: x.updatedAt && x.updatedAt.toMillis ? x.updatedAt.toMillis() : 0
      };
    });
  }
  /** マスター写真1枚。存在しなければ null */
  async function fetchMaster(id) {
    const s = await timeout(db.collection('masters').doc(id).get({ source: 'server' }), 30000);
    if (!s.exists) return null;
    const x = s.data();
    const bytes = x.photo && x.photo.toUint8Array ? x.photo.toUint8Array() : null;
    if (!bytes) return null;
    return {
      id, partNo: x.partNo, blob: new Blob([bytes], { type: 'image/jpeg' }),
      createdAt: x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : 0, createdBy: x.createdBy || ''
    };
  }

  /* ---- 書き込み（管理者のみ。ルールでも強制されます） ---- */
  async function createPart(partNo, name, email) {
    const ref = db.collection('parts').doc(partDocId(partNo));
    await timeout(db.runTransaction(async tx => {
      const s = await tx.get(ref);
      if (s.exists) throw Object.assign(new Error('その品番はすでにあります'), { code: 'already-exists' });
      tx.set(ref, { partNo, name: name || '', masterIds: [], updatedAt: ts(), updatedBy: email || '' });
    }), 20000);
  }
  /** fields: { name?, threshold? }  threshold に null を渡すと「標準に戻す」 */
  async function updatePart(partNo, fields, email) {
    const upd = { updatedAt: ts(), updatedBy: email || '' };
    if ('name' in fields) upd.name = fields.name || '';
    if ('threshold' in fields) upd.threshold = fields.threshold === null ? firebase.firestore.FieldValue.delete() : fields.threshold;
    await timeout(db.collection('parts').doc(partDocId(partNo)).update(upd), 20000);
  }
  /** マスター写真を追加して、品番の masterIds にも登録（まとめて1回で書き込み） */
  async function addMaster(partNo, blob, email) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const ref = db.collection('masters').doc();
    const batch = db.batch();
    batch.set(ref, { partNo, photo: firebase.firestore.Blob.fromUint8Array(bytes), bytes: bytes.length, createdAt: ts(), createdBy: email || '' });
    batch.update(db.collection('parts').doc(partDocId(partNo)), {
      masterIds: firebase.firestore.FieldValue.arrayUnion(ref.id), updatedAt: ts(), updatedBy: email || ''
    });
    await timeout(batch.commit(), 60000);
    return ref.id;
  }
  async function deleteMaster(partNo, id, email) {
    const batch = db.batch();
    batch.delete(db.collection('masters').doc(id));
    batch.update(db.collection('parts').doc(partDocId(partNo)), {
      masterIds: firebase.firestore.FieldValue.arrayRemove(id), updatedAt: ts(), updatedBy: email || ''
    });
    await timeout(batch.commit(), 30000);
  }
  async function deletePart(partNo) {
    const ref = db.collection('parts').doc(partDocId(partNo));
    const snap = await timeout(ref.get({ source: 'server' }), 15000);       // 他の管理者が足した写真も取りこぼさないよう、最新の一覧を読む
    const ids = snap.exists && Array.isArray(snap.data().masterIds) ? [...snap.data().masterIds] : [];
    while (ids.length) {                                                      // 念のため分割して削除
      const b = db.batch();
      ids.splice(0, 400).forEach(id => b.delete(db.collection('masters').doc(id)));
      await timeout(b.commit(), 30000);
    }
    await timeout(ref.delete(), 20000);
  }
  async function saveDefaultThreshold(v, email) {
    await timeout(db.doc('config/settings').set({ defaultThreshold: v, updatedAt: ts(), updatedBy: email || '' }), 20000);
  }

  return {
    configured, init, login, logout, onAuth, user, fetchRole, fetchSettings, fetchParts, fetchMaster,
    createPart, updatePart, addMaster, deleteMaster, deletePart, saveDefaultThreshold, partDocId
  };
})();
