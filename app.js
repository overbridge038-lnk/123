'use strict';
/* 誤品照合アプリ
 * - 写真の特徴量を MobileNetV2（同梱モデル）で数値化し、コサイン類似度で OK / NG を判定
 * - データはすべて IndexedDB（このタブレット内）に保存。外部へは送信しません。
 */

/* ================= 設定値 ================= */
const APP_VERSION = '1.0.0';
const MODEL_URL = 'model/model.json';
const FEATURE_NODE = 'module_apply_default/MobilenetV2/Conv_1/Relu6'; // 7x7x1280 の特徴マップ
const MODEL_VER = 'mnv2-1';       // モデルや計算方法を変えたら必ず変更（登録済み写真の特徴量を再計算するため）
const INPUT_SIZE = 224;
const MASTER_SIZE = 512;          // 保存するマスター写真の一辺(px)
const HIST_THUMB = 320;           // 履歴に残す現品写真の一辺(px)
const DEFAULT_THRESHOLD = 70;     // 標準しきい値(%)。実際の品物で必ず調整してください
const W_GLOBAL = 0.6;             // 全体の特徴の重み
const W_SPATIAL = 0.4;            // 位置ごとの特徴の重み
const PAGE = 50;                  // 履歴の1ページ件数

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= IndexedDB ================= */
let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('gohin-db', 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('parts', { keyPath: 'partNo' });
        db.createObjectStore('masters', { keyPath: 'id', autoIncrement: true }).createIndex('partNo', 'partNo');
        db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('kv');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
function dbDo(store, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const rq = fn(t.objectStore(store));
    t.oncomplete = () => resolve(rq && rq.result);
    t.onerror = t.onabort = () => reject(t.error);
  }));
}
const dbAll = s => dbDo(s, 'readonly', o => o.getAll());
const dbGet = (s, k) => dbDo(s, 'readonly', o => o.get(k));
const dbPut = (s, v, k) => dbDo(s, 'readwrite', o => o.put(v, k));
const dbDel = (s, k) => dbDo(s, 'readwrite', o => o.delete(k));
const dbClear = s => dbDo(s, 'readwrite', o => o.clear());
const mastersOf = partNo => dbDo('masters', 'readonly', o => o.index('partNo').getAll(partNo));
const kvGet = async (k, d) => { const v = await dbGet('kv', k); return v === undefined ? d : v; };
const kvSet = (k, v) => dbPut('kv', v, k);

async function deletePart(partNo) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction(['parts', 'masters'], 'readwrite');
    t.objectStore('parts').delete(partNo);
    const idx = t.objectStore('masters').index('partNo');
    idx.openKeyCursor(IDBKeyRange.only(partNo)).onsuccess = e => {
      const c = e.target.result;
      if (c) { t.objectStore('masters').delete(c.primaryKey); c.continue(); }
    };
    t.oncomplete = resolve; t.onerror = t.onabort = () => reject(t.error);
  });
}

/* ================= 設定の読み書き ================= */
const settings = { defaultThreshold: DEFAULT_THRESHOLD, operator: '', sound: true, vibrate: true };
async function loadSettings() {
  for (const k of Object.keys(settings)) settings[k] = await kvGet('set_' + k, settings[k]);
}
const saveSetting = (k, v) => { settings[k] = v; return kvSet('set_' + k, v); };

/* ================= 画面の小道具 ================= */
const urlGroups = {};
function mkUrl(group, blob) {
  const u = URL.createObjectURL(blob);
  (urlGroups[group] = urlGroups[group] || []).push(u);
  return u;
}
function clearUrls(group) { (urlGroups[group] || []).forEach(u => URL.revokeObjectURL(u)); urlGroups[group] = []; }

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** 汎用ダイアログ。build(dialogElement, close) で中身を作る */
function openDialog(build) {
  return new Promise(resolve => {
    const m = $('#modal'); m.innerHTML = ''; m.hidden = false;
    const d = document.createElement('div'); d.className = 'dialog'; m.appendChild(d);
    const close = v => { m.hidden = true; m.innerHTML = ''; resolve(v); };
    build(d, close);
  });
}
function ask(message, okLabel = 'はい', danger = false) {
  return openDialog((d, close) => {
    d.innerHTML = `<h3>${esc(message)}</h3><div class="row"><button class="btn" data-v="0">キャンセル</button><button class="btn ${danger ? 'danger' : 'primary'}" data-v="1">${esc(okLabel)}</button></div>`;
    d.querySelectorAll('button').forEach(b => b.onclick = () => close(b.dataset.v === '1'));
  });
}
function inform(message) {
  return openDialog((d, close) => {
    d.innerHTML = `<h3>${esc(message)}</h3><div class="row"><button class="btn primary">閉じる</button></div>`;
    d.querySelector('button').onclick = () => close();
  });
}
function promptText(title, fields) {
  return openDialog((d, close) => {
    d.innerHTML = `<h3>${esc(title)}</h3>` + fields.map((f, i) =>
      `<label class="field-label" style="margin-top:10px">${esc(f.label)}</label><input class="input" data-i="${i}" type="text" placeholder="${esc(f.placeholder || '')}" value="${esc(f.value || '')}">`).join('') +
      `<div class="row"><button class="btn" data-v="0">キャンセル</button><button class="btn primary" data-v="1">OK</button></div>`;
    const first = d.querySelector('input'); setTimeout(() => first && first.focus(), 50);
    d.querySelectorAll('button').forEach(b => b.onclick = () =>
      close(b.dataset.v === '1' ? [...d.querySelectorAll('input')].map(i => i.value.trim()) : null));
  });
}

/* ================= AI（特徴量と類似度） ================= */
let modelPromise = null;
function loadModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      await tf.ready();
      const m = await tf.loadGraphModel(MODEL_URL);
      const warm = m.execute(tf.zeros([1, INPUT_SIZE, INPUT_SIZE, 3]), FEATURE_NODE); // 初回の準備運転
      await warm.data(); warm.dispose();
      return m;
    })().catch(e => { modelPromise = null; throw e; });
  }
  return modelPromise;
}

/** canvas(正方形) → { g: 全体の特徴(1280), s: 位置ごとの特徴(3x3x1280) }  どちらも長さ1に正規化済み */
async function embed(canvas) {
  const m = await loadModel();
  const small = document.createElement('canvas');
  small.width = small.height = INPUT_SIZE;
  const ctx = small.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, INPUT_SIZE, INPUT_SIZE);
  const outs = tf.tidy(() => {
    const x = tf.browser.fromPixels(small).toFloat().div(127.5).sub(1).expandDims(0);
    const f = m.execute(x, FEATURE_NODE);                         // [1,7,7,1280]
    const l2 = t => t.div(t.norm().add(1e-8));
    const g = l2(f.mean([1, 2]).reshape([-1]));
    const s = l2(tf.image.resizeBilinear(f, [3, 3]).reshape([-1]));
    return [g, s];
  });
  const [g, s] = await Promise.all(outs.map(t => t.data()));
  outs.forEach(t => t.dispose());
  return { g: new Float32Array(g), s: new Float32Array(s), v: MODEL_VER };
}
function dot(a, b) { let t = 0; for (let i = 0; i < a.length; i++) t += a[i] * b[i]; return t; }
/** 類似度 0〜100(%) */
function similarity(a, b) {
  const v = W_GLOBAL * dot(a.g, b.g) + W_SPATIAL * dot(a.s, b.s);
  return Math.max(0, Math.min(100, v * 100));
}

/* ================= 画像・カメラ ================= */
function squareFrom(src, w, h, size = MASTER_SIZE) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const s = Math.min(w, h), ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
  return c;
}
const toBlob = (c, q = 0.9) => new Promise(r => c.toBlob(r, 'image/jpeg', q));
async function canvasFromFile(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const c = squareFrom(bmp, bmp.width, bmp.height);
  if (bmp.close) bmp.close();
  return c;
}
function shrink(canvas, size) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, size, size); return c;
}

class Camera {
  constructor(video) { this.video = video; this.stream = null; }
  get active() { return !!this.stream; }
  async start() {
    if (this.stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('このブラウザではカメラを使えません');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (e) {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play();
  }
  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null; this.video.srcObject = null;
  }
  capture() {
    const v = this.video;
    if (!v.videoWidth) throw new Error('カメラの準備中です');
    return squareFrom(v, v.videoWidth, v.videoHeight);
  }
}
function cameraErrorText(e) {
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) return 'カメラの許可がありません。ブラウザの設定でカメラを許可してください';
  if (e && e.name === 'NotFoundError') return 'カメラが見つかりません';
  return (e && e.message) || 'カメラを起動できませんでした';
}

/* ================= 音・振動・画面常時点灯 ================= */
let audioCtx = null;
function beep(freq, dur, when = 0) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; o.type = 'square'; g.gain.value = 0.15;
    o.connect(g); g.connect(audioCtx.destination);
    o.start(audioCtx.currentTime + when); o.stop(audioCtx.currentTime + when + dur);
  } catch (e) { /* 音が出せなくても続行 */ }
}
function notifyResult(ok) {
  if (settings.sound) { if (ok) beep(1200, 0.18); else { beep(300, 0.45); beep(300, 0.45, 0.6); } }
  if (settings.vibrate && navigator.vibrate) navigator.vibrate(ok ? 120 : [400, 150, 400]);
}
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}

/* ================= 品番の補助 ================= */
const thresholdOf = part => (part && typeof part.threshold === 'number') ? part.threshold : settings.defaultThreshold;
async function ensureEmbedding(m) {   // 特徴量が無い／古いモデルのものは作り直す
  if (m.emb && m.emb.v === MODEL_VER) return m;
  const c = await canvasFromFile(m.blob);
  m.emb = await embed(c);
  await dbPut('masters', m);
  return m;
}
async function addMasterFromCanvas(partNo, canvas) {
  const blob = await toBlob(canvas, 0.9);
  const emb = await embed(canvas);
  await dbPut('masters', { partNo, blob, emb, createdAt: Date.now() });
}
async function pickPart(currentNo) {
  const parts = (await dbAll('parts')).sort((a, b) => a.partNo.localeCompare(b.partNo, 'ja', { numeric: true }));
  return openDialog((d, close) => {
    d.innerHTML = `<h3>品番を選ぶ</h3><input class="input" type="search" placeholder="品番・品名で検索"><div class="pick-list"></div><div class="row"><button class="btn">閉じる</button></div>`;
    const list = $('.pick-list', d), inp = $('input', d);
    const draw = () => {
      const q = inp.value.trim().toLowerCase();
      const hit = parts.filter(p => !q || p.partNo.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q));
      list.innerHTML = hit.length ? '' : '<div class="hint">該当する品番がありません</div>';
      hit.forEach(p => {
        const b = document.createElement('button');
        b.className = 'pick-item' + (p.partNo === currentNo ? ' sel' : '');
        b.innerHTML = `<b>${esc(p.partNo)}</b><span>${esc(p.name || '')}</span>`;
        b.onclick = () => close(p.partNo);
        list.appendChild(b);
      });
    };
    inp.oninput = draw; draw();
    $('.row .btn', d).onclick = () => close(null);
  });
}

/* ================= タブ切り替え ================= */
let currentView = 'verify';
async function showView(name) {
  if (name === currentView && $('#view-' + name).classList.contains('active')) return;
  const prev = currentView;
  currentView = name;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === name));
  if (prev === 'verify') verify.leave();
  if (name === 'verify') verify.enter();
  if (name === 'master') master.enter();
  if (name === 'history') histView.enter();
  if (name === 'settings') settingsView.enter();
}

/* ================= 照合画面 ================= */
const verify = {
  part: null, masters: [], state: 'idle', cam: null, shown: 0, lastShotUrl: null, fallback: false,

  init() {
    this.cam = new Camera($('#video'));
    $('#partBtn').onclick = () => this.choosePart();
    $('#shootBtn').onclick = () => this.onShoot();
    $('#fileShootBtn').onclick = () => $('#shootFile').click();
    $('#shootFile').onchange = async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (f) await this.judge(await canvasFromFile(f));
    };
  },

  async enter() {
    keepAwake(true);
    const parts = await dbAll('parts');
    const last = await kvGet('lastPart', null);
    if (!this.part || !parts.find(p => p.partNo === this.part.partNo)) {
      this.part = parts.find(p => p.partNo === last) || null;
    } else {
      this.part = parts.find(p => p.partNo === this.part.partNo);
    }
    await this.loadMasters();
    this.render();
    if (!parts.length) this.setResult('idle', '待機中', '「登録」タブで品番とマスター写真を登録してください');
    if (this.state === 'result') return;
    this.state = 'live';
    this.startCamera();
  },
  leave() { this.cam.stop(); keepAwake(false); },

  async loadMasters() {
    this.masters = this.part ? await mastersOf(this.part.partNo) : [];
    this.masters.sort((a, b) => a.createdAt - b.createdAt);
    this.shown = 0;
  },

  async choosePart() {
    const no = await pickPart(this.part && this.part.partNo);
    if (!no) return;
    this.part = await dbGet('parts', no);
    await kvSet('lastPart', no);
    await this.loadMasters();
    this.state = 'live';
    this.showLive();
    this.setResult('idle', '待機中', '現品を四角の中に入れて「撮影して照合」を押してください');
    this.render();
    this.startCamera();
  },

  render() {
    clearUrls('verify');
    const btnText = $('#partBtnText');
    btnText.textContent = this.part ? this.part.partNo + (this.part.name ? '  ' + this.part.name : '') : 'タップして品番を選ぶ';
    const img = $('#masterImg'), empty = $('#masterEmpty'), th = $('#masterThumbs');
    th.innerHTML = '';
    if (!this.part) { img.removeAttribute('src'); img.hidden = true; empty.hidden = false; empty.textContent = '品番を選んでください'; }
    else if (!this.masters.length) { img.hidden = true; empty.hidden = false; empty.textContent = 'この品番にはマスター写真がありません。「登録」タブで追加してください'; }
    else {
      empty.hidden = true; img.hidden = false;
      img.src = mkUrl('verify', this.masters[this.shown].blob);
      if (this.masters.length > 1) this.masters.forEach((m, i) => {
        const t = document.createElement('img');
        t.src = mkUrl('verify', m.blob);
        t.className = (i === this.shown ? 'sel' : '') + (m.id === this.bestId ? ' best' : '');
        t.onclick = () => { this.shown = i; this.render(); };
        th.appendChild(t);
      });
    }
    const ready = !!(this.part && this.masters.length);
    $('#shootBtn').disabled = !ready || this.state === 'busy';
    $('#shootBtn').textContent = this.state === 'result' ? '次の照合へ' : '撮影して照合';
    $('#fileShootBtn').hidden = !this.fallback || this.state === 'result';
  },

  async startCamera() {
    const msg = $('#camMsg');
    try {
      await this.cam.start();
      msg.hidden = true; this.fallback = false;
    } catch (e) {
      msg.hidden = false; msg.textContent = cameraErrorText(e);
      this.fallback = true;
    }
    this.render();
  },

  showLive() { $('#video').hidden = false; $('#shotImg').hidden = true; },
  showShot(canvas) {
    if (this.lastShotUrl) URL.revokeObjectURL(this.lastShotUrl);
    toBlob(canvas, 0.8).then(b => {
      this.lastShotUrl = URL.createObjectURL(b);
      const s = $('#shotImg'); s.src = this.lastShotUrl; s.hidden = false; $('#video').hidden = true;
    });
  },

  setResult(kind, main, sub) {
    const r = $('#result'); r.className = 'result ' + kind;
    $('#resultMain').textContent = main; $('#resultSub').textContent = sub;
  },

  async onShoot() {
    if (this.state === 'result') {           // 次の照合へ
      this.state = 'live'; this.bestId = null; this.showLive();
      this.setResult('idle', '待機中', '現品を四角の中に入れて「撮影して照合」を押してください');
      this.render(); if (!this.cam.active) this.startCamera();
      return;
    }
    if (this.state !== 'live') return;
    let canvas;
    try { canvas = this.cam.capture(); }
    catch (e) { toast(e.message); return; }
    await this.judge(canvas);
  },

  async judge(canvas) {
    if (!this.part || !this.masters.length) { toast('マスター写真がありません'); return; }
    this.state = 'busy'; this.render();
    this.showShot(canvas);
    this.setResult('busy', '判定中…', 'AIが写真を比べています');
    try {
      const emb = await embed(canvas);
      const ms = [];
      for (const m of this.masters) ms.push(await ensureEmbedding(m));
      let best = null, bestScore = -1;
      for (const m of ms) { const s = similarity(emb, m.emb); if (s > bestScore) { bestScore = s; best = m; } }
      const threshold = thresholdOf(this.part);
      const ok = bestScore >= threshold;
      const score1 = Math.round(bestScore * 10) / 10;
      this.bestId = best.id;
      this.shown = this.masters.findIndex(m => m.id === best.id);
      this.setResult(ok ? 'ok' : 'ng', ok ? 'OK' : 'NG', `類似度 ${score1.toFixed(1)}%（しきい値 ${threshold}%）`);
      notifyResult(ok);
      const photo = await toBlob(shrink(canvas, HIST_THUMB), 0.8);
      await dbPut('history', {
        ts: Date.now(), partNo: this.part.partNo, partName: this.part.name || '', score: score1, threshold,
        result: ok ? 'OK' : 'NG', operator: settings.operator, masterId: best.id, photo
      });
    } catch (e) {
      console.error(e);
      this.setResult('ng', 'エラー', (e && e.message) || '判定に失敗しました');
    }
    this.state = 'result'; this.render();
  }
};

/* ================= 登録画面 ================= */
const master = {
  editing: null,
  init() {
    $('#addPartBtn').onclick = () => this.addPart();
    $('#partSearch').oninput = () => this.renderList();
    $('#editBackBtn').onclick = () => this.closeEdit();
    $('#saveNameBtn').onclick = async () => {
      this.editing.name = $('#editName').value.trim(); await dbPut('parts', this.editing); toast('保存しました');
    };
    $('#thMinus').onclick = () => this.stepTh(-1);
    $('#thPlus').onclick = () => this.stepTh(1);
    $('#thReset').onclick = async () => { delete this.editing.threshold; await dbPut('parts', this.editing); this.renderTh(); };
    $('#camAddBtn').onclick = () => this.addByCamera();
    $('#fileAddBtn').onclick = () => $('#addFile').click();
    $('#addFile').onchange = e => this.addByFiles([...e.target.files]).then(() => { e.target.value = ''; });
    $('#delPartBtn').onclick = async () => {
      if (!await ask(`品番「${this.editing.partNo}」とマスター写真を削除します。よろしいですか？`, '削除する', true)) return;
      await deletePart(this.editing.partNo); this.closeEdit(); toast('削除しました');
    };
  },
  async enter() { if (this.editing) await this.openEdit(this.editing.partNo); else await this.renderList(); },

  async renderList() {
    clearUrls('plist');
    const q = $('#partSearch').value.trim().toLowerCase();
    const parts = (await dbAll('parts')).sort((a, b) => a.partNo.localeCompare(b.partNo, 'ja', { numeric: true }));
    const masters = await dbAll('masters');
    const cards = $('#partCards'); cards.innerHTML = '';
    const hit = parts.filter(p => !q || p.partNo.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q));
    if (!hit.length) cards.innerHTML = `<div class="hint">${parts.length ? '該当なし' : '品番がまだありません。「＋ 品番を追加」を押してください。'}</div>`;
    hit.forEach(p => {
      const ms = masters.filter(m => m.partNo === p.partNo).sort((a, b) => a.createdAt - b.createdAt);
      const b = document.createElement('button'); b.className = 'pcard';
      b.innerHTML = (ms.length ? `<img src="${mkUrl('plist', ms[0].blob)}" alt="">` : '<div class="noimg"></div>') +
        `<div><div class="t">${esc(p.partNo)}</div><div class="s">${esc(p.name || '（品名なし）')}</div>` +
        `<div class="s ${ms.length ? '' : 'warn'}">${ms.length ? 'マスター ' + ms.length + '枚' : 'マスター未登録'}</div></div>`;
      b.onclick = () => this.openEdit(p.partNo);
      cards.appendChild(b);
    });
  },

  async addPart() {
    const r = await promptText('品番を追加', [{ label: '品番（必須）', placeholder: '例：AB-1234' }, { label: '品名（省略可）', placeholder: '例：ブラケット' }]);
    if (!r) return;
    const [partNo, name] = r;
    if (!partNo) { toast('品番を入力してください'); return; }
    if (await dbGet('parts', partNo)) { toast('その品番はすでにあります'); return; }
    await dbPut('parts', { partNo, name, createdAt: Date.now() });
    await this.openEdit(partNo);
  },

  async openEdit(partNo) {
    const p = await dbGet('parts', partNo);
    if (!p) { this.closeEdit(); return; }
    this.editing = p;
    $('#masterList').hidden = true; $('#partEdit').hidden = false;
    $('#editTitle').textContent = p.partNo; $('#editName').value = p.name || '';
    this.renderTh(); await this.renderMasters();
  },
  closeEdit() { this.editing = null; clearUrls('medit'); $('#partEdit').hidden = true; $('#masterList').hidden = false; this.renderList(); },

  renderTh() {
    const v = thresholdOf(this.editing);
    $('#thValue').textContent = v + '%';
  },
  async stepTh(d) {
    const v = Math.max(1, Math.min(99, thresholdOf(this.editing) + d));
    this.editing.threshold = v; await dbPut('parts', this.editing); this.renderTh();
  },

  async renderMasters() {
    clearUrls('medit');
    const ms = (await mastersOf(this.editing.partNo)).sort((a, b) => a.createdAt - b.createdAt);
    const g = $('#editMasters'); g.innerHTML = ms.length ? '' : '<div class="hint">マスター写真がまだありません</div>';
    ms.forEach(m => {
      const c = document.createElement('div'); c.className = 'mcell';
      c.innerHTML = `<img src="${mkUrl('medit', m.blob)}" alt=""><button type="button" aria-label="削除">×</button>`;
      c.querySelector('button').onclick = async () => {
        if (!await ask('このマスター写真を削除しますか？', '削除する', true)) return;
        await dbDel('masters', m.id); this.renderMasters();
      };
      g.appendChild(c);
    });
  },

  async addByFiles(files) {
    if (!files.length) return;
    toast('登録中…', 60000);
    try {
      for (const f of files) await addMasterFromCanvas(this.editing.partNo, await canvasFromFile(f));
      toast(files.length + '枚 登録しました');
    } catch (e) { toast('登録に失敗しました：' + e.message, 4000); }
    this.renderMasters();
  },

  async addByCamera() {
    const partNo = this.editing.partNo;
    let added = 0;
    await openDialog((d, close) => {
      d.innerHTML = `<h3>マスター写真を撮影（${esc(partNo)}）</h3>
        <div class="square"><video playsinline muted autoplay></video><img hidden alt=""><div class="empty" hidden></div></div>
        <div class="hint" id="camHelp">四角の中央が登録される範囲です。現品を真ん中に置いてください。</div>
        <div class="row"><button class="btn" id="cClose">閉じる</button><button class="btn primary" id="cShoot">撮影</button></div>`;
      const cam = new Camera($('video', d)), img = $('img', d), msg = $('.empty', d), shoot = $('#cShoot', d);
      let mode = 'live', shot = null;
      const finish = () => { cam.stop(); close(); };
      $('#cClose', d).onclick = finish;
      cam.start().catch(e => { msg.hidden = false; msg.textContent = cameraErrorText(e); shoot.disabled = true; });
      shoot.onclick = async () => {
        if (mode === 'live') {
          try { shot = cam.capture(); } catch (e) { toast(e.message); return; }
          img.src = URL.createObjectURL(await toBlob(shot, 0.8)); img.hidden = false; $('video', d).hidden = true;
          mode = 'confirm'; shoot.textContent = 'この写真を登録';
          $('#cClose', d).textContent = '撮り直す';
          $('#cClose', d).onclick = () => { URL.revokeObjectURL(img.src); img.hidden = true; $('video', d).hidden = false; mode = 'live'; shoot.textContent = '撮影'; $('#cClose', d).textContent = '閉じる'; $('#cClose', d).onclick = finish; };
        } else {
          shoot.disabled = true; shoot.textContent = '登録中…';
          try { await addMasterFromCanvas(partNo, shot); added++; toast('登録しました（' + added + '枚）'); this.renderMasters(); }
          catch (e) { toast('登録に失敗：' + e.message, 4000); }
          URL.revokeObjectURL(img.src); img.hidden = true; $('video', d).hidden = false;
          mode = 'live'; shoot.disabled = false; shoot.textContent = '続けて撮影'; $('#cClose', d).textContent = '終了';
          $('#cClose', d).onclick = finish;
        }
      };
    });
    this.renderMasters();
  }
};

/* ================= 履歴画面 ================= */
const histView = {
  rows: [], filtered: [], shown: 0, resultFilter: '',
  init() {
    $('#histSearch').oninput = () => this.apply();
    $$('#histResult button').forEach(b => b.onclick = () => {
      $$('#histResult button').forEach(x => x.classList.toggle('on', x === b));
      this.resultFilter = b.dataset.v; this.apply();
    });
    $('#histMore').onclick = () => this.draw(true);
    $('#csvBtn').onclick = () => this.exportCsv();
    $('#clearHistBtn').onclick = async () => {
      if (!await ask('履歴をすべて削除します。先にCSVで書き出しましたか？', '全部削除する', true)) return;
      await dbClear('history'); this.enter(); toast('削除しました');
    };
  },
  async enter() {
    this.rows = (await dbAll('history')).sort((a, b) => b.ts - a.ts);
    this.apply();
  },
  apply() {
    const q = $('#histSearch').value.trim().toLowerCase();
    this.filtered = this.rows.filter(r => (!this.resultFilter || r.result === this.resultFilter) && (!q || r.partNo.toLowerCase().includes(q)));
    this.shown = 0; $('#histList').innerHTML = ''; clearUrls('hist');
    const ng = this.filtered.filter(r => r.result === 'NG').length;
    $('#histSummary').textContent = `${this.filtered.length}件（OK ${this.filtered.length - ng} / NG ${ng}）`;
    this.draw(false);
  },
  draw() {
    const list = $('#histList');
    this.filtered.slice(this.shown, this.shown + PAGE).forEach(r => {
      const b = document.createElement('button'); b.className = 'hrow';
      b.innerHTML = (r.photo ? `<img src="${mkUrl('hist', r.photo)}" alt="">` : '<div style="width:64px;height:64px"></div>') +
        `<div class="mid"><div class="p">${esc(r.partNo)}</div><div class="d">${fmtDate(r.ts)}　類似度 ${r.score.toFixed(1)}%（基準 ${r.threshold}%）${r.operator ? '　' + esc(r.operator) : ''}</div></div><div class="badge ${r.result}">${r.result}</div>`;
      b.onclick = () => this.detail(r);
      list.appendChild(b);
    });
    this.shown += PAGE;
    $('#histMore').hidden = this.shown >= this.filtered.length;
    if (!this.filtered.length) list.innerHTML = '<div class="hint">履歴はありません</div>';
  },
  detail(r) {
    clearUrls('histd');
    openDialog((d, close) => {
      d.innerHTML = `<h3>${esc(r.partNo)}　<span class="badge ${r.result}">${r.result}</span></h3>` +
        (r.photo ? `<img class="photo" src="${mkUrl('histd', r.photo)}" alt="">` : '') +
        `<p>${fmtDate(r.ts)}<br>類似度 ${r.score.toFixed(1)}%（しきい値 ${r.threshold}%）${r.operator ? '<br>作業者：' + esc(r.operator) : ''}</p>` +
        `<div class="row"><button class="btn danger" id="hDel">この履歴を削除</button><button class="btn primary" id="hClose">閉じる</button></div>`;
      $('#hClose', d).onclick = () => close();
      $('#hDel', d).onclick = async () => { await dbDel('history', r.id); close(); this.enter(); };
    }).then(() => clearUrls('histd'));
  },
  exportCsv() {
    if (!this.filtered.length) { toast('書き出す履歴がありません'); return; }
    const q = s => '"' + String(s).replace(/"/g, '""') + '"';
    const lines = [['日時', '品番', '品名', '結果', '類似度(%)', 'しきい値(%)', '作業者'].map(q).join(',')];
    [...this.filtered].reverse().forEach(r => lines.push([fmtDate(r.ts), r.partNo, r.partName || '', r.result, r.score.toFixed(1), r.threshold, r.operator || ''].map(q).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const n = new Date(), p = x => String(x).padStart(2, '0');
    a.download = `gohin_${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}_${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}.csv`;
    a.href = URL.createObjectURL(blob); document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast(`${this.filtered.length}件をCSVに書き出しました`);
  }
};
function fmtDate(ts) {
  const d = new Date(ts), p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ================= 設定画面 ================= */
const settingsView = {
  init() {
    const step = d => async () => {
      await saveSetting('defaultThreshold', Math.max(1, Math.min(99, settings.defaultThreshold + d))); this.fill();
    };
    $('#dthMinus').onclick = step(-1); $('#dthPlus').onclick = step(1);
    $('#operator').oninput = e => saveSetting('operator', e.target.value.trim());
    $('#optSound').onchange = e => { saveSetting('sound', e.target.checked); if (e.target.checked) beep(1200, 0.15); };
    $('#optVibrate').onchange = e => { saveSetting('vibrate', e.target.checked); if (e.target.checked && navigator.vibrate) navigator.vibrate(150); };
    $('#wipeBtn').onclick = async () => {
      if (!await ask('品番・マスター写真・履歴をすべて削除します。本当によろしいですか？', 'すべて削除する', true)) return;
      for (const s of ['parts', 'masters', 'history']) await dbClear(s);
      verify.part = null; await kvSet('lastPart', null); toast('削除しました'); this.fill();
    };
  },
  async enter() { this.fill(); },
  async fill() {
    $('#dthValue').textContent = settings.defaultThreshold + '%';
    $('#operator').value = settings.operator;
    $('#optSound').checked = settings.sound; $('#optVibrate').checked = settings.vibrate;
    const [np, nm, nh] = [(await dbAll('parts')).length, (await dbAll('masters')).length, (await dbAll('history')).length];
    let usage = '';
    try {
      const e = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      usage = `／使用 ${(e.usage / 1048576).toFixed(1)}MB（${persisted ? 'データ保護：有効' : 'データ保護：未設定'}）`;
    } catch (e) { /* 取得できなくても続行 */ }
    $('#storageInfo').textContent = `品番 ${np}件／マスター写真 ${nm}枚／履歴 ${nh}件${usage}`;
    $('#appInfo').textContent = `バージョン ${APP_VERSION}／モデル ${MODEL_VER}／${navigator.onLine ? 'オンライン' : 'オフライン'}／${('serviceWorker' in navigator && navigator.serviceWorker.controller) ? 'オフライン動作：準備OK' : 'オフライン動作：準備中（一度ネットに繋いだまま開いてください）'}`;
  }
};

/* ================= 起動 ================= */
async function main() {
  await openDB();
  await loadSettings();
  $$('#tabs button').forEach(b => b.onclick = () => showView(b.dataset.view));
  verify.init(); master.init(); histView.init(); settingsView.init();

  document.addEventListener('visibilitychange', () => {
    if (currentView !== 'verify') return;
    if (document.hidden) { verify.cam.stop(); keepAwake(false); }
    else { keepAwake(true); if (verify.state === 'live') verify.startCamera(); }
  });

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW登録失敗', e));

  verify.enter();

  const bar = $('#modelBar');
  loadModel().then(() => { bar.classList.add('ready'); }).catch(e => {
    console.error(e); bar.classList.add('error');
    bar.textContent = 'AIモデルを読み込めませんでした。ページを再読み込みしてください';
  });
}
window.__gohin = { embed, similarity, squareFrom, loadModel };   // 動作確認用
main();
