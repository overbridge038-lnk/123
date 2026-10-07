'use strict';
/* keys.js の動作確認（node tests/keys.test.js で実行）。
 * 白い背景に黒い部品を置いた疑似写真を作り、位置をずらした正しい品・欠品・刻印違い・撮影不良の写真と比べて、
 * 「正しい品は OK、誤品は OK にならない、撮影不良は判定不能」になるかを確かめます。 */
const Keys = require('../keys.js');
const W = Keys.WORK;

function rnd(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function blur(d, w, h) {   // 軽いぼかし（カメラの解像度を再現）
  const o = new Float32Array(d.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const k = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1); s += d[yy * w + xx] * k; c += k;
    }
    o[y * w + x] = s / c;
  }
  return o;
}

/** 疑似写真。variant:
 *  'A' 正しい品 / 'noHole' 右の穴なし / 'noTab' 突起(ブラケット)なし / 'noBolt' 上面のボルトなし /
 *  'wrongStamp' 刻印の形が違う / 'noStamp' 刻印なし / 'bigger' 一回り大きい別品番 */
function scene(variant, tf, o) {
  o = o || {};
  const R = rnd(o.seed || 1), d = new Float32Array(W * W);
  const c = W / 2, ct = Math.cos(tf.th), st = Math.sin(tf.th), k = variant === 'bigger' ? 1.12 : 1;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const rx = x - c - tf.tx, ry = y - c - tf.ty;
    const u = (ct * rx + st * ry) / k + c, v = (-st * rx + ct * ry) / k + c;     // 部品の座標
    let val = (o.bg || 245) - (o.bgGrad || 0) * (x / W);
    const body = u > 70 && u < 250 && v > 110 && v < 210;
    const tab = variant !== 'noTab' && u > 215 && u < 250 && v > 70 && v <= 110;       // 突起（輪郭の外に出る）
    let part = body || tab;
    if ((u - 105) ** 2 + (v - 160) ** 2 < 14 * 14) part = false;                        // 左の穴
    if (variant !== 'noHole' && (u - 215) ** 2 + (v - 160) ** 2 < 14 * 14) part = false; // 右の穴
    if (part) {
      val = 40 + 10 * (u / W);
      // 上面のボルト（輪郭は変わらない。ふちが明るく光る）
      if (variant !== 'noBolt') { const r2 = (u - 160) ** 2 + (v - 135) ** 2; if (r2 < 11 * 11 && r2 > 8 * 8) val = 95; else if (r2 <= 8 * 8) val = 60; }
      // 刻印（明るい線のパターン）
      if (variant !== 'noStamp' && u > 130 && u < 200 && v > 175 && v < 195) {
        const bar = variant === 'wrongStamp' ? (Math.floor((u - 130) / 7) % 3 === 1 || (Math.abs(v - 185) < 1.5)) : (Math.floor((u - 130) / 7) % 2 === 0);
        if (bar) val = 75;
      }
    }
    d[y * W + x] = val;
  }
  let out = blur(d, W, W);
  if (o.blur) for (let i = 0; i < o.blur; i++) out = blur(out, W, W);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, out[i] * (o.gain || 1) + (o.bias || 0) + (R() - 0.5) * 2 * (o.noise === undefined ? 1.5 : o.noise)));
  return { w: W, h: W, d: out };
}
const IDENT = { th: 0, tx: 0, ty: 0 };
const D = Math.PI / 180;

const KEYS = [
  { id: 'k1', name: '左の穴', type: 'shape', x: 0.26, y: 0.44, w: 0.15, h: 0.12, must: true },
  { id: 'k2', name: '右の穴', type: 'shape', x: 0.62, y: 0.44, w: 0.15, h: 0.12, must: true },
  { id: 'k3', name: '突起', type: 'presence', x: 0.66, y: 0.21, w: 0.14, h: 0.14, must: true },
  { id: 'k4', name: '上面ボルト', type: 'presence', x: 0.42, y: 0.37, w: 0.16, h: 0.12, must: true, exp: { present: true } },
  { id: 'k5', name: '刻印', type: 'engrave', x: 0.39, y: 0.53, w: 0.25, h: 0.08, must: true }
];
let fail = 0;
function check(name, cond, info) { console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (info ? '  ' + info : '')); if (!cond) fail++; }

const mg = scene('A', IDENT, { seed: 1, noise: 0 });
const man = Keys.analyze(mg);
check('マスター写真の品質チェックが通る', man.ok, man.issues.map(i => i.msg).join(' / ') + ' ' + JSON.stringify(man.m));
const mprep = Keys.prepare(mg, man);
const masters = [{ id: 'm1', prep: mprep, an: man, keys: KEYS }];
const show = r => r.items.map(i => `${i.name}:${i.state}(${i.score})`).join(' ');

const GOOD = [
  { th: 0, tx: 0, ty: 0 }, { th: 6 * D, tx: 12, ty: -9 }, { th: -11 * D, tx: -15, ty: 10 }, { th: 21 * D, tx: 8, ty: 14 }, { th: 175 * D, tx: 0, ty: 0 }
];
const LIGHT = [{ gain: 1, noise: 2 }, { gain: 0.93, bias: 6, noise: 2 }, { gain: 1.04, bias: -4, noise: 2.5 }];
let nGoodOk = 0, nGood = 0, maxMs = 0;
GOOD.forEach((tf, i) => {
  const t0 = Date.now(), r = Keys.evaluate(masters, scene('A', tf, Object.assign({ seed: 10 + i }, LIGHT[i % 3])));
  const ms = Date.now() - t0; maxMs = Math.max(maxMs, ms);
  nGood++; if (r.result === 'OK') nGoodOk++;
  console.log(`  正しい品${i}: ${r.result} 位置合わせ ${(r.conf * 100).toFixed(0)}% (${ms}ms) ${r.reason.slice(0, 60)} ${show(r)}`);
});
check('正しい品は全部 OK（ずれ・回転・明るさ違いを含む）', nGoodOk === nGood, `${nGoodOk}/${nGood}`);
check('1回の判定が2秒以内', maxMs < 2000, maxMs + 'ms');

const tfs = [{ th: 5 * D, tx: 10, ty: -8 }, { th: -9 * D, tx: -12, ty: 12 }];
const BAD = [
  ['noHole', '右の穴なし'], ['noTab', '突起なし'], ['noBolt', '上面ボルトなし'], ['wrongStamp', '刻印違い'], ['noStamp', '刻印なし']
];
for (const [v, label] of BAD) {
  tfs.forEach((tf, i) => {
    const r = Keys.evaluate(masters, scene(v, tf, Object.assign({ seed: 30 + i }, LIGHT[i])));
    console.log(`  誤品(${label})${i}: ${r.result} 位置合わせ ${(r.conf * 100).toFixed(0)}% ${r.reason.slice(0, 70)} ${show(r)}`);
    check(`誤品(${label})は OK にならない(${i})`, r.result !== 'OK');
    if (v !== 'noStamp') check(`誤品(${label})は NG になる(${i})`, r.result === 'NG', r.result);
  });
}
{
  const r = Keys.evaluate(masters, scene('bigger', IDENT, { seed: 5 }));
  console.log('  別品番(一回り大きい):', r.result, (r.conf * 100).toFixed(0) + '%', r.reason.slice(0, 60), show(r));
  check('一回り大きい別品番は OK にならない', r.result !== 'OK');
}

/* ---- 撮影不良は判定不能 ---- */
const unk = (name, shot, code) => {
  const r = Keys.evaluate(masters, shot);
  const got = r.issues.map(i => i.code).join(',');
  check(name + ' → 判定不能', r.result === 'UNK', r.result + ' ' + got + ' ' + r.reason.slice(0, 50));
  if (code) check('  警告の種類に ' + code + ' を含む', r.issues.some(i => i.code === code), got);
};
unk('ピンぼけ', scene('A', tfs[0], { seed: 41, blur: 14 }), 'blur');
unk('暗い写真', scene('A', tfs[0], { seed: 42, gain: 0.45, bg: 245 }), 'dark');
unk('明るすぎる写真', (() => { const s = scene('A', tfs[0], { seed: 43 }); for (let i = 0; i < s.d.length; i++) s.d[i] = Math.min(255, s.d[i] * 1.2 + 120); return s; })(), 'bright');
unk('背景にむら', scene('A', tfs[0], { seed: 44, bgGrad: 90 }), 'bgnoise');
unk('部品なし', { w: W, h: W, d: new Float32Array(W * W).fill(245) }, 'none');
unk('枠からはみ出し', scene('A', { th: 0, tx: 85, ty: 0 }, { seed: 45 }), 'frame');
{
  // 部品が2つ
  const a = scene('A', { th: 0, tx: 0, ty: 0 }, { seed: 46 });
  for (let y = 0; y < 50; y++) for (let x = 10; x < 60; x++) a.d[(y + 14) * W + x + 5] = 45;
  unk('部品が複数', a, 'multi');
}
{
  // 位置合わせに失敗（形がまるで違う：丸い部品）
  const d = new Float32Array(W * W).fill(245);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if ((x - 160) ** 2 + (y - 160) ** 2 < 70 * 70) d[y * W + x] = 40;
  const r = Keys.evaluate(masters, { w: W, h: W, d });
  check('形がまるで違う写真は OK にならない', r.result !== 'OK', r.result + ' ' + (r.conf * 100).toFixed(0) + '% ' + r.reason.slice(0, 60));
}
/* ---- 参考キー・必須キーなし・キーなし ---- */
{
  const ref = KEYS.map(k => Object.assign({}, k, { must: k.id === 'k1' }));
  const m2 = [{ id: 'm1', prep: mprep, an: man, keys: ref }];
  const r = Keys.evaluate(m2, scene('noHole', tfs[0], { seed: 50 }));
  check('参考キーがNGでも、必須キーがOKなら総合OK（参考は警告のみ）', r.result === 'OK', r.result + ' ' + show(r));
  const none = Keys.evaluate([{ id: 'm1', prep: mprep, an: man, keys: KEYS.map(k => Object.assign({}, k, { must: false })) }], scene('A', tfs[0], { seed: 51 }));
  check('必須キーが1つも無いと判定不能', none.result === 'UNK', none.reason);
  const nokey = Keys.evaluate([{ id: 'm1', prep: mprep, an: man, keys: [] }], scene('A', tfs[0], { seed: 52 }));
  check('キー未登録は判定不能', nokey.result === 'UNK', nokey.reason);
  const bad = Keys.evaluate(masters, null);
  check('異常な入力でも例外にならず判定不能（OKを出さない）', bad.result === 'UNK', bad.reason);
}
/* ---- 領域の補助 ---- */
{
  const flat = Keys.describeRegion(mprep, { type: 'shape', x: 0.02, y: 0.02, w: 0.1, h: 0.1 });
  check('何も無い領域に形状キーを置くと警告', !!flat.warn && !flat.present, JSON.stringify(flat));
  const hole = Keys.describeRegion(mprep, KEYS[0]);
  check('穴を含む領域は輪郭あり', hole.hasOutline && !hole.warn);
  const eng = Keys.describeRegion(mprep, KEYS[4]);
  check('刻印の領域はコントラストあり', eng.contrast >= Keys.ENG_MIN && !eng.warn, eng.contrast.toFixed(1));
}
console.log(fail ? `\n${fail} 件失敗` : '\n全部OK');
process.exit(fail ? 1 : 0);
