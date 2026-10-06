'use strict';
/* 誤品照合アプリ
 * - 写真の特徴量を MobileNetV2（同梱モデル）で数値化し、コサイン類似度で OK / NG を判定（処理は端末内）
 * - マスター（品番・写真）は Firebase（Firestore）で全員が共有し、各端末の IndexedDB にキャッシュ（cloud.js）
 * - 照合履歴はこの端末の IndexedDB にだけ保存します。
 */

/* ================= 設定値 ================= */
const APP_VERSION = '2.1.0';
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
const DEFAULT_POINT_TH = 70;      // 検査ポイントの標準しきい値(%)。実際の品物で必ず調整してください
const ALIGN_MIN = 0.3;            // 位置合わせの良さ(0〜1)がこれ未満なら「位置合わせ失敗」
const POINT_COVER_MIN = 0.6;      // ポイントの四角のうち、現品の写真に入っている割合の下限
const MAX_ALIGN = 8;              // 位置合わせを試すマスター写真の最大数（時間がかかりすぎないように）

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= IndexedDB =================
 * cparts / cmasters : クラウドのマスターのキャッシュ
 * parts / masters   : クラウド対応前の旧データ（移行用。新規インストールでは作られません）
 * history / kv      : 履歴・設定（この端末だけ） */
let dbPromise = null;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('gohin-db', 2);
      r.onupgradeneeded = e => {
        const db = r.result;
        if (e.oldVersion < 1) {
          db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
          db.createObjectStore('kv');
        }
        db.createObjectStore('cparts', { keyPath: 'partNo' });
        db.createObjectStore('cmasters', { keyPath: 'id' }).createIndex('partNo', 'partNo');
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
const mastersOf = partNo => dbDo('cmasters', 'readonly', o => o.index('partNo').getAll(partNo));
const kvGet = async (k, d) => { const v = await dbGet('kv', k); return v === undefined ? d : v; };
const kvSet = (k, v) => dbPut('kv', v, k);

/* ================= 設定の読み書き ================= */
const settings = { defaultThreshold: DEFAULT_THRESHOLD, pointThreshold: DEFAULT_POINT_TH, combineGlobal: false, operator: '', sound: true, vibrate: true };
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
/** 正方形の canvas → クラウドに保存する JPEG（長辺 800px 以内・品質 0.8・400KB 以下） */
async function compressForCloud(canvas) {
  let side = Math.min(canvas.width, PHOTO_MAX_SIDE), q = PHOTO_QUALITY;
  for (let i = 0; i < 12; i++) {
    const c = side === canvas.width ? canvas : shrink(canvas, side);
    const blob = await toBlob(c, q);
    if (blob && blob.size <= PHOTO_MAX_BYTES) return { blob, w: c.width, h: c.height };
    if (q > 0.55) q -= 0.1; else { side = Math.round(side * 0.85); q = PHOTO_QUALITY; }
  }
  throw new Error('写真を400KB以下にできませんでした');
}
async function canvasFromFile(file, size = MASTER_SIZE) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const c = squareFrom(bmp, bmp.width, bmp.height, Math.min(size, bmp.width, bmp.height));
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
  capture(size = MASTER_SIZE) {
    const v = this.video;
    if (!v.videoWidth) throw new Error('カメラの準備中です');
    return squareFrom(v, v.videoWidth, v.videoHeight, Math.min(size, v.videoWidth, v.videoHeight));
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

function friendlyError(e) {
  const c = (e && e.code) || '';
  if (c === 'permission-denied') return '権限がありません。管理者アカウントでログインしているか確認してください';
  if (c === 'unavailable') return '通信できません。電波を確認してください';
  return (e && e.message) || '失敗しました';
}

/* ================= 品番の補助 ================= */
const thresholdOf = part => (part && typeof part.threshold === 'number') ? part.threshold : settings.defaultThreshold;
async function ensureEmbedding(m) {   // 特徴量が無い／古いモデルのものは作り直す
  if (m.emb && m.emb.v === MODEL_VER) return m;
  const c = await canvasFromFile(m.blob);
  m.emb = await embed(c);
  if (await dbGet('cmasters', m.id)) await dbPut('cmasters', m);   // 同期で消えた写真を復活させない
  return m;
}
/* ---- 検査ポイント ----
 * 品番データの points = { マスター写真ID: [ { name, x, y, w, h, must, th? } ] }
 * x,y,w,h は写真の大きさに対する比率(0〜1)。must=false は「参考」、th が無ければ標準のしきい値 */
const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0));
function cleanPoints(list) {
  const out = [];
  for (const p of (Array.isArray(list) ? list : [])) {
    if (!p || out.length >= POINTS_PER_PHOTO) continue;
    const x = clamp01(p.x), y = clamp01(p.y), w = Math.min(clamp01(p.w), 1 - x), h = Math.min(clamp01(p.h), 1 - y);
    if (w < 0.01 || h < 0.01) continue;
    const q = { name: String(p.name || '').slice(0, 30) || 'ポイント' + (out.length + 1), x, y, w, h, must: p.must !== false };
    if (typeof p.th === 'number' && p.th >= 1 && p.th <= 99) q.th = Math.round(p.th);
    out.push(q);
  }
  return out;
}
const pointsOf = (part, photoId) => cleanPoints(part && part.points && part.points[photoId]);
const pointTh = p => typeof p.th === 'number' ? p.th : settings.pointThreshold;

/** canvas → 形状照合用の白黒画像（384px四方） */
function grayFromCanvas(canvas) {
  const n = Shape.WORK, c = document.createElement('canvas'); c.width = c.height = n;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(canvas, 0, 0, n, n);
  const px = ctx.getImageData(0, 0, n, n).data, d = new Float32Array(n * n);
  for (let i = 0; i < d.length; i++) d[i] = 0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2];
  return { w: n, h: n, d };
}
const shapeCache = new Map();      // マスター写真ID → 位置合わせ用データ（計算し直しを避ける）
async function masterShape(m) {
  const hit = shapeCache.get(m.id);
  if (hit && hit.size === m.blob.size) return hit.prep;
  const bmp = await createImageBitmap(m.blob, { imageOrientation: 'from-image' });
  const c = squareFrom(bmp, bmp.width, bmp.height, Shape.WORK);
  if (bmp.close) bmp.close();
  const prep = Shape.prepare(grayFromCanvas(c));
  shapeCache.set(m.id, { size: m.blob.size, prep });
  return prep;
}

/** 写真(canvas)を圧縮してクラウドに登録する（管理者のみ） */
async function addMasterFromCanvas(partNo, canvas) {
  const { blob, w, h } = await compressForCloud(canvas);
  await cloud.addPhoto(partNo, blob, w, h);
}
async function pickPart(currentNo) {
  const parts = (await dbAll('cparts')).sort((a, b) => a.partNo.localeCompare(b.partNo, 'ja', { numeric: true }));
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
  part: null, masters: [], state: 'idle', cam: null, shown: 0, lastShotUrl: null, fallback: false, overlay: null,

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
    const parts = await dbAll('cparts');
    const last = await kvGet('lastPart', null);
    if (!this.part || !parts.find(p => p.partNo === this.part.partNo)) {
      this.part = parts.find(p => p.partNo === last) || null;
    } else {
      this.part = parts.find(p => p.partNo === this.part.partNo);
    }
    await this.loadMasters();
    this.render();
    if (!parts.length) this.setResult('idle', '待機中', cloud.isAdmin() ? '「登録」タブで品番とマスター写真を登録してください' : 'マスターがまだありません。ネットに繋ぐと自動で取得します');
    if (this.state === 'result') return;
    this.state = 'live';
    this.startCamera();
  },
  leave() { this.cam.stop(); keepAwake(false); },

  /** 同期でマスターが変わったとき、カメラはそのままで表示だけ更新する */
  async refresh() {
    if (this.state === 'busy') return;
    const parts = await dbAll('cparts');
    this.part = this.part ? (parts.find(p => p.partNo === this.part.partNo) || null) : null;
    await this.loadMasters();
    this.render();
  },

  async loadMasters() {
    this.masters = this.part ? await mastersOf(this.part.partNo) : [];
    this.masters.sort((a, b) => a.createdAt - b.createdAt);
    this.shown = 0;
  },

  async choosePart() {
    const no = await pickPart(this.part && this.part.partNo);
    if (!no) return;
    this.part = await dbGet('cparts', no);
    await kvSet('lastPart', no);
    await this.loadMasters();
    this.state = 'live'; this.overlay = null; this.showPointList(null);
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
    this.renderOverlay();
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

  showLive() { $('#video').hidden = false; $('#shotImg').hidden = true; this.renderOverlay(); },
  showShot(canvas) {
    if (this.lastShotUrl) URL.revokeObjectURL(this.lastShotUrl);
    toBlob(canvas, 0.8).then(b => {
      this.lastShotUrl = URL.createObjectURL(b);
      const s = $('#shotImg'); s.src = this.lastShotUrl; s.hidden = false; $('#video').hidden = true;
      this.renderOverlay();
    });
  },

  setResult(kind, main, sub) {
    const r = $('#result'); r.className = 'result ' + kind;
    $('#resultMain').textContent = main; $('#resultSub').textContent = sub;
  },

  async onShoot() {
    if (this.state === 'result') {           // 次の照合へ
      this.state = 'live'; this.bestId = null; this.overlay = null; this.showPointList(null); this.showLive();
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
    this.state = 'busy'; this.overlay = null; this.render();
    this.showShot(canvas);
    this.setResult('busy', '判定中…', 'AIが写真を比べています');
    try {
      const ptMasters = this.masters.filter(m => pointsOf(this.part, m.id).length);
      if (ptMasters.length) await this.judgePoints(canvas, ptMasters);
      else await this.judgeGlobal(canvas);
    } catch (e) {
      console.error(e);
      this.setResult('ng', 'エラー', (e && e.message) || '判定に失敗しました');
      this.showPointList(null);
    }
    this.state = 'result'; this.render();
  },

  /** 従来の方式：写真全体の見た目の類似度 */
  async judgeGlobal(canvas) {
    const { score, best } = await this.globalScore(canvas);
    const threshold = thresholdOf(this.part), ok = score >= threshold;
    const score1 = Math.round(score * 10) / 10;
    this.bestId = best.id;
    this.shown = this.masters.findIndex(m => m.id === best.id);
    this.setResult(ok ? 'ok' : 'ng', ok ? 'OK' : 'NG', `類似度 ${score1.toFixed(1)}%（しきい値 ${threshold}%）`);
    this.showPointList(null);
    notifyResult(ok);
    await this.saveHistory(canvas, { score: score1, threshold, result: ok ? 'OK' : 'NG', masterId: best.id });
  },

  /** 全マスターとの全体の類似度（いちばん高いもの） */
  async globalScore(canvas) {
    const emb = await embed(canvas);
    let best = null, score = -1;
    for (const m of this.masters) {
      await ensureEmbedding(m);
      const s = similarity(emb, m.emb);
      if (s > score) { score = s; best = m; }
    }
    return { score, best };
  },

  /** 検査ポイント方式：位置合わせ → ポイントごとに形状を比べる */
  async judgePoints(canvas, ptMasters) {
    const shot = Shape.prepare(grayFromCanvas(canvas));
    let best = null;
    const cands = ptMasters.slice(0, MAX_ALIGN);
    for (let i = 0; i < cands.length; i++) {
      this.setResult('busy', '判定中…', cands.length > 1 ? `位置合わせ ${i + 1}/${cands.length}` : '位置合わせ中');
      await sleep(30);                                     // 画面の更新を先に済ませる
      const mp = await masterShape(cands[i]);
      const al = Shape.align(mp, shot);
      if (!best || al.score > best.al.score) best = { m: cands[i], mp, al };
    }
    this.bestId = best.m.id;
    this.shown = this.masters.findIndex(m => m.id === best.m.id);
    if (best.al.score < ALIGN_MIN || best.al.cover < Shape.MIN_COVER) {
      this.setResult('ng', 'NG', '位置合わせできませんでした。現品を四角の中央に置いて撮り直してください');
      this.showPointList(null);
      notifyResult(false);
      await this.saveHistory(canvas, { score: 0, threshold: settings.pointThreshold, result: 'NG', masterId: best.m.id, mode: 'points', note: '位置合わせ失敗' });
      return;
    }
    await sleep(0);
    const pts = pointsOf(this.part, best.m.id);
    const res = Shape.checkPoints(best.mp, shot, best.al.P, pts);
    const items = pts.map((p, i) => {
      const score = Math.round(res[i].score * 10) / 10, th = pointTh(p), out = res[i].cover < POINT_COVER_MIN;
      const corners = [[p.x, p.y], [p.x + p.w, p.y], [p.x + p.w, p.y + p.h], [p.x, p.y + p.h]];
      return {
        name: p.name, score, th, must: p.must !== false, out, ok: !out && score >= th,
        rect: p, quad: corners.map(([x, y]) => Shape.mapPoint(best.al.P, x, y))
      };
    });
    const must = items.filter(i => i.must), mustNg = must.filter(i => !i.ok), refNg = items.filter(i => !i.must && !i.ok);
    let ok = mustNg.length === 0, sub;
    const okN = items.filter(i => i.ok).length;
    sub = `ポイント ${okN}/${items.length} OK`;
    if (!ok) sub += '　NG：' + mustNg.map(i => i.name).join('、');
    else if (refNg.length) sub += `（参考NG：${refNg.map(i => i.name).join('、')}）`;
    let global = null;
    if (settings.combineGlobal) {                          // 併用：全体の類似度も条件に加える
      const g = await this.globalScore(canvas), th = thresholdOf(this.part);
      global = { score: Math.round(g.score * 10) / 10, threshold: th };
      const gok = g.score >= th;
      sub += `　全体 ${global.score.toFixed(1)}%（基準 ${th}%）` + (gok ? '' : ' NG');
      ok = ok && gok;
    }
    this.overlay = { masterId: best.m.id, items };
    this.setResult(ok ? 'ok' : 'ng', ok ? 'OK' : 'NG', sub);
    this.showPointList(items);
    notifyResult(ok);
    const low = Math.min(...items.map(i => i.score));
    await this.saveHistory(canvas, {
      score: low, threshold: settings.pointThreshold, result: ok ? 'OK' : 'NG', masterId: best.m.id, mode: 'points',
      points: items.map(i => ({ name: i.name, score: i.score, th: i.th, ok: i.ok, must: i.must })), global
    });
  },

  async saveHistory(canvas, rec) {
    const photo = await toBlob(shrink(canvas, HIST_THUMB), 0.8);
    await dbPut('history', Object.assign({
      ts: Date.now(), partNo: this.part.partNo, partName: this.part.name || '', operator: settings.operator, photo
    }, rec));
  },

  /** 結果の下にポイントごとの一覧を出す */
  showPointList(items) {
    const box = $('#pointList');
    box.hidden = !items;
    box.innerHTML = items ? items.map((it, i) =>
      `<span class="pchip ${it.ok ? 'ok' : 'ng'}${it.must ? '' : ' ref'}">${i + 1}.${esc(it.name)} ${it.out ? '範囲外' : it.score.toFixed(0) + '%'}${it.must ? '' : '（参考）'}</span>`).join('') : '';
  },

  /** 現品写真（と、あればマスター写真）に、OK=緑・NG=赤の枠を重ねる */
  renderOverlay() {
    const shot = $('#shotOverlay'), mst = $('#masterOverlay'), o = this.overlay;
    const cls = it => it.ok ? 'okc' : 'ngc';
    const mark = (it, i, pts) => {
      const dash = it.must ? '' : ' stroke-dasharray="9 6"';
      return `<polygon class="${cls(it)}" points="${pts.map(q => q.map(v => v.toFixed(4)).join(',')).join(' ')}"${dash}/>` +
        `<text class="${cls(it)}" x="${(pts[0][0] + 0.005).toFixed(4)}" y="${(pts[0][1] - 0.008).toFixed(4)}">${i + 1}</text>`;
    };
    const show = !!o && this.state === 'result' && !$('#shotImg').hidden;
    shot.toggleAttribute('hidden', !show); shot.innerHTML = show ? o.items.map((it, i) => mark(it, i, it.quad)).join('') : '';
    const mshow = !!o && this.state === 'result' && this.masters[this.shown] && this.masters[this.shown].id === o.masterId;
    mst.toggleAttribute('hidden', !mshow);
    mst.innerHTML = mshow ? o.items.map((it, i) => {
      const r = it.rect;
      return mark(it, i, [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]);
    }).join('') : '';
  }
};

/* ================= 登録画面 ================= */
const master = {
  editing: null,
  init() {
    $('#addPartBtn').onclick = () => this.addPart();
    $('#partSearch').oninput = () => this.renderList();
    $('#editBackBtn').onclick = () => this.closeEdit();
    $('#saveNameBtn').onclick = () => this.run(async () => {
      const name = $('#editName').value.trim();
      await cloud.updatePart(this.editing.partNo, { name });
      this.editing.name = name; await dbPut('cparts', this.editing); toast('保存しました');
    });
    $('#thMinus').onclick = () => this.stepTh(-1);
    $('#thPlus').onclick = () => this.stepTh(1);
    $('#thReset').onclick = () => this.run(async () => {
      await cloud.updatePart(this.editing.partNo, { threshold: null });
      delete this.editing.threshold; await dbPut('cparts', this.editing); this.renderTh();
    });
    $('#camAddBtn').onclick = () => this.addByCamera();
    $('#fileAddBtn').onclick = () => $('#addFile').click();
    $('#addFile').onchange = e => this.addByFiles([...e.target.files]).then(() => { e.target.value = ''; });
    $('#delPartBtn').onclick = async () => {
      if (!await ask(`品番「${this.editing.partNo}」とマスター写真を削除します。全員のタブレットから消えます。よろしいですか？`, '削除する', true)) return;
      await this.run(async () => { await cloud.deletePart(this.editing.partNo); this.closeEdit(); toast('削除しました'); });
    };
  },
  /** クラウドへの書き込みをまとめて実行し、失敗したら理由を表示する */
  async run(fn) {
    try { await fn(); } catch (e) { console.error(e); toast(friendlyError(e), 5000); }
  },
  async enter() { if (this.editing) await this.openEdit(this.editing.partNo); else await this.renderList(); },

  async renderList() {
    clearUrls('plist');
    const q = $('#partSearch').value.trim().toLowerCase();
    const parts = (await dbAll('cparts')).sort((a, b) => a.partNo.localeCompare(b.partNo, 'ja', { numeric: true }));
    const masters = await dbAll('cmasters');
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
    if (/[\/]/.test(partNo) || partNo === '.' || partNo === '..' || /^__.*__$/.test(partNo) || partNo.length > 100) {
      toast('品番に「/」は使えません（100文字まで）', 4000); return;
    }
    if (await dbGet('cparts', partNo)) { toast('その品番はすでにあります'); return; }
    toast('登録中…', 30000);
    await this.run(async () => {
      await cloud.createPart(partNo, name);
      await dbPut('cparts', { partNo, name, photoIds: [], createdAt: Date.now(), updatedAt: Date.now() });
      toast('品番を登録しました');
      await this.openEdit(partNo);
    });
  },

  async openEdit(partNo) {
    const p = await dbGet('cparts', partNo);
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
    this.editing.threshold = v; this.renderTh();
    clearTimeout(this.thTimer);                      // 連打しても、止まってから1回だけ送る
    const no = this.editing.partNo;
    this.thTimer = setTimeout(() => this.run(async () => {
      await cloud.updatePart(no, { threshold: v });
      const cur = await dbGet('cparts', no); if (cur) { cur.threshold = v; await dbPut('cparts', cur); }
    }), 700);
  },

  async renderMasters() {
    clearUrls('medit');
    const ms = (await mastersOf(this.editing.partNo)).sort((a, b) => a.createdAt - b.createdAt);
    const g = $('#editMasters'); g.innerHTML = ms.length ? '' : '<div class="hint">マスター写真がまだありません</div>';
    ms.forEach(m => {
      const c = document.createElement('div'); c.className = 'mcell';
      const np = pointsOf(this.editing, m.id).length;
      c.innerHTML = `<img src="${mkUrl('medit', m.blob)}" alt=""><button type="button" aria-label="削除">×</button><button type="button" class="pt">◎ 検査ポイント ${np}</button>`;
      c.querySelector('button.pt').onclick = () => this.editPoints(m);
      c.querySelector('button').onclick = async () => {
        if (!await ask('このマスター写真を削除しますか？', '削除する', true)) return;
        await this.run(async () => { await cloud.deletePhoto(this.editing.partNo, m.id); await this.renderMasters(); });
      };
      g.appendChild(c);
    });
  },

  /** 検査ポイントの登録画面：マスター写真の上を指でなぞって四角を作る。移動・拡大縮小・削除ができる */
  async editPoints(m) {
    const partNo = this.editing.partNo;
    const pts = pointsOf(this.editing, m.id).map(p => Object.assign({}, p));
    let sel = -1, dirty = false, drag = null;
    const url = URL.createObjectURL(m.blob), img = new Image();
    await openDialog((d, close) => {
      d.classList.add('wide');
      d.innerHTML = `<h3>検査ポイント（${esc(partNo)}）</h3>
        <div class="pe-wrap">
          <div class="pe-box"><canvas id="peCanvas"></canvas></div>
          <div class="pe-side">
            <div class="hint" id="peHint"></div>
            <div class="pe-list" id="peList"></div>
            <div class="pe-form" id="peForm" hidden>
              <label class="field-label">名前（例：左の穴、先端の形）</label>
              <input class="input" id="peName" type="text" maxlength="30">
              <label class="field-label" style="margin-top:12px">しきい値（形の一致度 %）</label>
              <div class="stepper">
                <button id="peThM" class="btn step" type="button">−</button>
                <div id="peThV" class="step-val" style="font-size:32px;min-width:100px">70%</div>
                <button id="peThP" class="btn step" type="button">＋</button>
                <button id="peThR" class="btn" type="button">標準</button>
              </div>
              <label class="field-label" style="margin-top:12px">重要度</label>
              <div class="seg" id="peMust"><button type="button" data-v="1">必須</button><button type="button" data-v="0">参考</button></div>
              <div class="hint">必須：NGなら全体もNG。参考：結果に表示するだけ。</div>
              <button id="peDel" class="btn danger" type="button" style="margin-top:8px">この四角を削除</button>
            </div>
          </div>
        </div>
        <div class="row"><button class="btn" id="peClose">閉じる</button><button class="btn primary" id="peSave">保存</button></div>`;
      const cv = $('#peCanvas', d), ctx = cv.getContext('2d');
      let size = 300;
      const draw = () => {
        const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
        size = r.width || size;
        if (cv.width !== Math.round(size * dpr)) cv.width = cv.height = Math.round(size * dpr);
        ctx.setTransform(cv.width / size, 0, 0, cv.width / size, 0, 0);
        ctx.clearRect(0, 0, size, size);
        if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, size, size);
        pts.forEach((p, i) => {
          const x = p.x * size, y = p.y * size, w = p.w * size, h = p.h * size, on = i === sel;
          ctx.lineWidth = on ? 4 : 3; ctx.strokeStyle = on ? '#ff9800' : (p.must ? '#00e5ff' : '#b2ff59');
          ctx.fillStyle = on ? 'rgba(255,152,0,.22)' : 'rgba(0,229,255,.14)';
          ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
          ctx.font = 'bold 18px sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = '#000'; ctx.fillStyle = '#fff';
          ctx.strokeText(String(i + 1), x + 4, y + 20); ctx.fillText(String(i + 1), x + 4, y + 20);
          if (on) {
            ctx.fillStyle = '#ff9800'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
            for (const [cx, cy] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) { ctx.beginPath(); ctx.arc(cx, cy, 11, 0, 7); ctx.fill(); ctx.stroke(); }
          }
        });
      };
      const form = () => {
        const p = pts[sel];
        $('#peForm', d).hidden = !p;
        $('#peHint', d).textContent = pts.length
          ? (pts.length >= POINTS_PER_PHOTO ? `最大${POINTS_PER_PHOTO}個に達しました。` : '空いている所を指でなぞると四角が増えます。') + '四角の中を動かすと移動、角の丸を動かすと大きさが変わります。'
          : '写真の上を指でなぞって、形の違いが出る場所を四角で囲んでください（最大' + POINTS_PER_PHOTO + '個）。';
        const list = $('#peList', d); list.innerHTML = '';
        pts.forEach((q, i) => {
          const b = document.createElement('button'); b.type = 'button'; b.className = i === sel ? 'sel' : '';
          b.textContent = `${i + 1}. ${q.name}${q.must ? '' : '（参考）'}`;
          b.onclick = () => { sel = i; form(); draw(); };
          list.appendChild(b);
        });
        if (!p) return;
        $('#peName', d).value = p.name;
        $('#peThV', d).textContent = (typeof p.th === 'number' ? p.th : settings.pointThreshold) + '%' + (typeof p.th === 'number' ? '' : '（標準）');
        $$('#peMust button', d).forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === p.must));
      };
      const refresh = () => { form(); draw(); };
      img.onload = refresh; img.src = url;
      new ResizeObserver(draw).observe(cv);

      $('#peName', d).oninput = e => { if (pts[sel]) { pts[sel].name = e.target.value.slice(0, 30); dirty = true; const b = $('#peList', d).children[sel]; if (b) b.textContent = `${sel + 1}. ${pts[sel].name}${pts[sel].must ? '' : '（参考）'}`; } };
      const stepTh = dv => { const p = pts[sel]; if (!p) return; p.th = Math.max(1, Math.min(99, (typeof p.th === 'number' ? p.th : settings.pointThreshold) + dv)); dirty = true; refresh(); };
      $('#peThM', d).onclick = () => stepTh(-1); $('#peThP', d).onclick = () => stepTh(1);
      $('#peThR', d).onclick = () => { if (pts[sel]) { delete pts[sel].th; dirty = true; refresh(); } };
      $$('#peMust button', d).forEach(b => b.onclick = () => { if (pts[sel]) { pts[sel].must = b.dataset.v === '1'; dirty = true; refresh(); } });
      $('#peDel', d).onclick = () => { if (sel < 0) return; pts.splice(sel, 1); sel = -1; dirty = true; refresh(); };

      /* ---- 指の操作：新しく描く／動かす／大きさを変える ---- */
      const norm = e => { const r = cv.getBoundingClientRect(); return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)]; };
      const HIT = 26;                                   // 角をつかめる範囲(px)
      cv.onpointerdown = e => {
        e.preventDefault(); cv.setPointerCapture(e.pointerId);
        const [nx, ny] = norm(e), hr = HIT / size;
        if (sel >= 0) {                                  // ① 選択中の四角の角
          const p = pts[sel], cs = [[p.x, p.y], [p.x + p.w, p.y], [p.x + p.w, p.y + p.h], [p.x, p.y + p.h]];
          const k = cs.findIndex(([cx, cy]) => Math.hypot(cx - nx, cy - ny) < hr);
          if (k >= 0) { const [ax, ay] = cs[(k + 2) % 4]; drag = { mode: 'resize', ax, ay }; return; }
        }
        let hit = -1;                                    // ② 四角の中（選択中を優先、次に小さいもの）
        const inside = p => nx >= p.x && nx <= p.x + p.w && ny >= p.y && ny <= p.y + p.h;
        if (sel >= 0 && inside(pts[sel])) hit = sel;
        else pts.forEach((p, i) => { if (inside(p) && (hit < 0 || p.w * p.h < pts[hit].w * pts[hit].h)) hit = i; });
        if (hit >= 0) { sel = hit; drag = { mode: 'move', ox: nx - pts[hit].x, oy: ny - pts[hit].y }; refresh(); return; }
        if (pts.length >= POINTS_PER_PHOTO) { toast(`検査ポイントは${POINTS_PER_PHOTO}個までです`); sel = -1; refresh(); return; }
        pts.push({ name: 'ポイント' + (pts.length + 1), x: nx, y: ny, w: 0, h: 0, must: true });   // ③ 新しく描く
        sel = pts.length - 1; drag = { mode: 'new', ax: nx, ay: ny, fresh: true }; refresh();
      };
      cv.onpointermove = e => {
        if (!drag) return;
        const [nx, ny] = norm(e), p = pts[sel]; if (!p) return;
        if (drag.mode === 'move') { p.x = Math.max(0, Math.min(1 - p.w, nx - drag.ox)); p.y = Math.max(0, Math.min(1 - p.h, ny - drag.oy)); }
        else { p.x = Math.min(drag.ax, nx); p.y = Math.min(drag.ay, ny); p.w = Math.abs(nx - drag.ax); p.h = Math.abs(ny - drag.ay); }
        dirty = true; draw();
      };
      const end = () => {
        if (!drag) return;
        const p = pts[sel];
        if (p && drag.mode !== 'move' && (p.w < 0.03 || p.h < 0.03)) {      // 小さすぎる四角は取り消し（タップしただけ）
          if (drag.fresh) { pts.splice(sel, 1); sel = -1; } else { p.w = Math.max(p.w, 0.03); p.h = Math.max(p.h, 0.03); p.x = Math.min(p.x, 1 - p.w); p.y = Math.min(p.y, 1 - p.h); }
        }
        drag = null; refresh();
      };
      cv.onpointerup = cv.onpointercancel = end;

      const finish = v => { URL.revokeObjectURL(url); close(v); };
      $('#peClose', d).onclick = async () => { if (!dirty || await ask('保存していない変更があります。閉じてよいですか？', '閉じる', true)) finish(false); };
      $('#peSave', d).onclick = async () => {
        const btn = $('#peSave', d); btn.disabled = true; btn.textContent = '保存中…';
        try { await cloud.setPoints(partNo, m.id, cleanPoints(pts)); toast('検査ポイントを保存しました'); finish(true); }
        catch (e) { console.error(e); toast('保存に失敗：' + friendlyError(e), 6000); btn.disabled = false; btn.textContent = '保存'; }
      };
    });
    const cur = await dbGet('cparts', partNo); if (cur && this.editing) this.editing = cur;
    this.renderMasters();
  },

  async addByFiles(files) {
    if (!files.length) return;
    toast('登録中…', 60000);
    try {
      for (const f of files) await addMasterFromCanvas(this.editing.partNo, await canvasFromFile(f, PHOTO_MAX_SIDE));
      toast(files.length + '枚 登録しました');
    } catch (e) { toast('登録に失敗しました：' + friendlyError(e), 5000); }
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
          try { shot = cam.capture(PHOTO_MAX_SIDE); } catch (e) { toast(e.message); return; }
          img.src = URL.createObjectURL(await toBlob(shot, 0.8)); img.hidden = false; $('video', d).hidden = true;
          mode = 'confirm'; shoot.textContent = 'この写真を登録';
          $('#cClose', d).textContent = '撮り直す';
          $('#cClose', d).onclick = () => { URL.revokeObjectURL(img.src); img.hidden = true; $('video', d).hidden = false; mode = 'live'; shoot.textContent = '撮影'; $('#cClose', d).textContent = '閉じる'; $('#cClose', d).onclick = finish; };
        } else {
          shoot.disabled = true; shoot.textContent = '登録中…';
          try { await addMasterFromCanvas(partNo, shot); added++; toast('登録しました（' + added + '枚）'); this.renderMasters(); }
          catch (e) { toast('登録に失敗：' + friendlyError(e), 5000); }
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
        `<div class="mid"><div class="p">${esc(r.partNo)}</div><div class="d">${fmtDate(r.ts)}　${histScore(r)}${r.operator ? '　' + esc(r.operator) : ''}</div></div><div class="badge ${r.result}">${r.result}</div>`;
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
        `<p>${fmtDate(r.ts)}<br>${histScore(r)}${r.operator ? '<br>作業者：' + esc(r.operator) : ''}</p>` +
        (r.mode === 'points' && r.points ? '<p>' + r.points.map((p, i) => `${p.ok ? '✅' : '❌'} ${i + 1}.${esc(p.name)} ${p.score.toFixed(0)}%（基準 ${p.th}%）${p.must ? '' : '（参考）'}`).join('<br>') + '</p>' : '') +
        `<div class="row"><button class="btn danger" id="hDel">この履歴を削除</button><button class="btn primary" id="hClose">閉じる</button></div>`;
      $('#hClose', d).onclick = () => close();
      $('#hDel', d).onclick = async () => { await dbDel('history', r.id); close(); this.enter(); };
    }).then(() => clearUrls('histd'));
  },
  exportCsv() {
    if (!this.filtered.length) { toast('書き出す履歴がありません'); return; }
    const q = s => '"' + String(s).replace(/"/g, '""') + '"';
    const lines = [['日時', '品番', '品名', '結果', '類似度(%)', 'しきい値(%)', '作業者', '方式', 'NGポイント'].map(q).join(',')];
    [...this.filtered].reverse().forEach(r => lines.push([fmtDate(r.ts), r.partNo, r.partName || '', r.result, r.mode === 'points' ? '' : r.score.toFixed(1), r.mode === 'points' ? '' : r.threshold, r.operator || '', r.mode === 'points' ? '検査ポイント' : '全体の類似度', (r.points || []).filter(p => !p.ok).map(p => p.name).concat(r.note ? [r.note] : []).join(' / ')].map(q).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const n = new Date(), p = x => String(x).padStart(2, '0');
    a.download = `gohin_${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}_${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}.csv`;
    a.href = URL.createObjectURL(blob); document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast(`${this.filtered.length}件をCSVに書き出しました`);
  }
};
/** 履歴1件の点数の説明（検査ポイント方式かどうかで変わる） */
function histScore(r) {
  if (r.mode !== 'points') return `類似度 ${r.score.toFixed(1)}%（基準 ${r.threshold}%）`;
  if (r.note) return esc(r.note);
  const n = (r.points || []).length, ok = (r.points || []).filter(p => p.ok).length;
  return `ポイント ${ok}/${n} OK` + (r.global ? `／全体 ${r.global.score.toFixed(1)}%（基準 ${r.global.threshold}%）` : '');
}
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
    const stepP = d => async () => {
      await saveSetting('pointThreshold', Math.max(1, Math.min(99, settings.pointThreshold + d))); this.fill();
    };
    $('#pthMinus').onclick = stepP(-1); $('#pthPlus').onclick = stepP(1);
    $('#optCombine').onchange = e => saveSetting('combineGlobal', e.target.checked);
    $('#operator').oninput = e => saveSetting('operator', e.target.value.trim());
    $('#optSound').onchange = e => { saveSetting('sound', e.target.checked); if (e.target.checked) beep(1200, 0.15); };
    $('#optVibrate').onchange = e => { saveSetting('vibrate', e.target.checked); if (e.target.checked && navigator.vibrate) navigator.vibrate(150); };
    $('#logoutBtn').onclick = async () => {
      if (await ask('ログアウトします。よろしいですか？', 'ログアウト')) cloud.signOut();
    };
    $('#resyncBtn').onclick = () => { cloud.resync(); toast('同期を確認しています'); };
    $('#migrateBtn').onclick = () => this.migrate();
    $('#wipeBtn').onclick = async () => {
      if (!await ask('この端末の履歴とマスターのコピーを削除します（クラウドのマスターは消えません）。よろしいですか？', '削除する', true)) return;
      for (const s of ['cparts', 'cmasters', 'history']) await dbClear(s);
      verify.part = null; await kvSet('lastPart', null); toast('削除しました'); this.fill();
      afterDataChange(); cloud.resync();
    };
  },
  async enter() { this.fill(); },

  /** クラウド対応前に端末内へ登録していた品番・写真をクラウドへ移す（管理者のみ） */
  async migrate() {
    if (!await ask('この端末だけに登録していた品番とマスター写真を、クラウドへ移します。よろしいですか？', '移行する')) return;
    const db = await openDB();
    const all = s => new Promise((res, rej) => { const r = db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const del = (s, k) => new Promise((res, rej) => { const t = db.transaction(s, 'readwrite'); t.objectStore(s).delete(k); t.oncomplete = res; t.onerror = () => rej(t.error); });
    let okParts = 0, skipped = 0;
    try {
      const parts = await all('parts'), masters = await all('masters');
      for (const p of parts) {
        toast(`移行中… ${p.partNo}`, 60000);
        if (await dbGet('cparts', p.partNo)) { skipped++; continue; }    // クラウドに同じ品番があれば触らない
        await cloud.createPart(p.partNo, p.name || '');
        if (typeof p.threshold === 'number') await cloud.updatePart(p.partNo, { threshold: p.threshold });
        for (const m of masters.filter(x => x.partNo === p.partNo)) {
          await addMasterFromCanvas(p.partNo, await canvasFromFile(m.blob, PHOTO_MAX_SIDE));
          await del('masters', m.id);
        }
        await del('parts', p.partNo); okParts++;
      }
      toast(`${okParts}品番を移行しました` + (skipped ? `（${skipped}品番は同じ品番がクラウドにあるため残しました）` : ''), 6000);
    } catch (e) { console.error(e); toast('移行を中断しました：' + friendlyError(e), 6000); }
    this.fill();
  },

  async fill() {
    $('#dthValue').textContent = settings.defaultThreshold + '%';
    $('#pthValue').textContent = settings.pointThreshold + '%';
    $('#optCombine').checked = settings.combineGlobal;
    $('#operator').value = settings.operator;
    $('#optSound').checked = settings.sound; $('#optVibrate').checked = settings.vibrate;
    const [np, nm, nh] = [(await dbAll('cparts')).length, (await dbAll('cmasters')).length, (await dbAll('history')).length];
    let usage = '';
    try {
      const e = await navigator.storage.estimate();
      const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      usage = `／使用 ${(e.usage / 1048576).toFixed(1)}MB（${persisted ? 'データ保護：有効' : 'データ保護：未設定'}）`;
    } catch (e) { /* 取得できなくても続行 */ }
    const u = cloud.user;
    $('#accountInfo').textContent = u ? `${u.email}（${cloud.isAdmin() ? '管理者' : '照合のみ'}）／${cloud.status.text || '—'}` : '未ログイン';
    $('#migrateBlock').hidden = !(cloud.isAdmin() && (await legacyCount()) > 0);
    $('#storageInfo').textContent = `品番 ${np}件／マスター写真 ${nm}枚／履歴 ${nh}件${usage}`;
    $('#appInfo').textContent = `バージョン ${APP_VERSION}／モデル ${MODEL_VER}／${navigator.onLine ? 'オンライン' : 'オフライン'}／${('serviceWorker' in navigator && navigator.serviceWorker.controller) ? 'オフライン動作：準備OK' : 'オフライン動作：準備中（一度ネットに繋いだまま開いてください）'}`;
  }
};

/* ================= ログイン・同期の表示 ================= */
async function legacyCount() {
  const db = await openDB();
  if (!db.objectStoreNames.contains('parts')) return 0;
  return new Promise(res => { const r = db.transaction('parts').objectStore('parts').count(); r.onsuccess = () => res(r.result); r.onerror = () => res(0); });
}

function showLogin(mode, message) {   // mode: 'form' | 'notice'（設定未完了・権限なし）
  const box = $('#login'); box.hidden = false;
  const note = $('#loginNotice');
  note.hidden = !message; note.textContent = message || '';
  $('#loginFields').hidden = mode === 'notice';
  $('#loginOut').hidden = mode !== 'notice' || !cloud.user;
  $('#loginError').hidden = true;
  $('#loginBtn').disabled = false; $('#loginBtn').textContent = 'ログイン';
  verify.leave();
}

function updateSyncBar() {
  const b = $('#syncBar'), st = cloud.status;
  b.hidden = !(cloud.user && st.text);
  b.className = 'sync-bar ' + st.kind;
  b.textContent = '☁ ' + st.text;
  if (currentView === 'settings') settingsView.fill();
}

/** マスターのキャッシュが変わったあと、いま開いている画面を更新する */
let refreshTimer;
function afterDataChange() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (currentView === 'verify') verify.refresh();
    else if (currentView === 'master') {
      if (master.editing) {
        const p = await dbGet('cparts', master.editing.partNo);
        if (!p) master.closeEdit(); else { master.editing = p; master.renderTh(); master.renderMasters(); }
      } else master.renderList();
    }
  }, 150);
}

function applyRole() {
  const admin = cloud.isAdmin();
  $('#tabs button[data-view="master"]').hidden = !admin;
  if (!admin && currentView === 'master') showView('verify');
}

function initCloudUi() {
  cloud.onStatus = updateSyncBar;
  cloud.onData = afterDataChange;
  cloud.onUser = ev => {
    if (ev === 'out') {
      $('#syncBar').hidden = true; applyRole();
      $('#loginPass').value = '';
      showLogin('form');
    } else if (ev === 'denied') {
      showLogin('notice', 'このアカウントは利用が許可されていません。管理者に連絡してください。');
      applyRole();
    } else {                                  // 'in' または 'role'
      $('#login').hidden = true; applyRole();
      if (ev === 'in') {
        if (currentView === 'verify') verify.enter();
      }
      if (currentView === 'settings') settingsView.fill();
    }
  };
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    const btn = $('#loginBtn'), err = $('#loginError');
    btn.disabled = true; btn.textContent = 'ログイン中…'; err.hidden = true;
    try { await cloud.signIn($('#loginEmail').value, $('#loginPass').value); }
    catch (ex) { err.hidden = false; err.textContent = authErrorText(ex); btn.disabled = false; btn.textContent = 'ログイン'; }
  };
  $('#loginOut').onclick = () => cloud.signOut();
}

/* ================= 起動 ================= */
async function main() {
  await openDB();
  await loadSettings();
  $$('#tabs button').forEach(b => b.onclick = () => showView(b.dataset.view));
  verify.init(); master.init(); histView.init(); settingsView.init();
  initCloudUi();
  $('#tabs button[data-view="master"]').hidden = true;     // 管理者と確認できるまで「登録」タブは出さない
  if (!cloud.init()) {
    showLogin('notice', 'Firebase の設定がまだ入っていません。firebase-config.js に設定値を貼り付けてください（手順は README を見てください）。');
  }

  document.addEventListener('visibilitychange', () => {
    if (currentView !== 'verify' || !$('#login').hidden) return;
    if (document.hidden) { verify.cam.stop(); keepAwake(false); }
    else { keepAwake(true); if (verify.state === 'live') verify.startCamera(); }
  });

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW登録失敗', e));

  const bar = $('#modelBar');
  loadModel().then(() => { bar.classList.add('ready'); }).catch(e => {
    console.error(e); bar.classList.add('error');
    bar.textContent = 'AIモデルを読み込めませんでした。ページを再読み込みしてください';
  });
}
window.__gohin = { embed, similarity, squareFrom, loadModel, Shape };   // 動作確認用
main();
