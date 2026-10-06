'use strict';
/* shape.js の動作確認（node tests/shape.test.js で実行）。
 * 疑似的な部品の絵を作り、ずらした・暗くした「現品」と比べて、位置合わせと形状比較が期待どおり動くかを確かめます。 */
const Shape = require('../shape.js');
const W = Shape.WORK;

function rnd(seed) { let s = seed; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

/** 部品の絵（背景は明るい灰色、部品は暗い）。variant 'A' = 正しい品、'B' = 右の穴が四角で、先端の形が違う */
function scene(variant, tf, light, seed) {
  const R = rnd(seed), d = new Float32Array(W * W);
  const { s, th, tx, ty } = tf, c = (W - 1) / 2, ct = Math.cos(th), st = Math.sin(th);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    // 画像座標 → 部品座標（逆変換）
    const rx = x - c - tx, ry = y - c - ty;
    const u = ( ct * rx + st * ry) / s + c, v = (-st * rx + ct * ry) / s + c;
    let val = 190 + 25 * (x / W);                          // 背景（なだらかな明るさのむら）
    const inBody = u > 90 && u < 300 && v > 130 && v < 250;
    const tip = v > 150 && v < 230 && u >= 300 && u < (variant === 'A' ? 350 : 330);   // 先端
    const rr = (a, b, r) => (u - a) ** 2 + (v - b) ** 2 < r * r;
    let part = inBody || tip;
    if (rr(140, 190, 16)) part = false;                    // 左の穴（A, B 共通）
    if (variant === 'A' ? rr(240, 190, 16) : (Math.abs(u - 240) < 16 && Math.abs(v - 190) < 16)) part = false; // 右の穴
    if (part) val = 70 + 20 * (u / W);
    d[y * W + x] = Math.max(0, Math.min(255, val * light.gain + light.bias + (R() - 0.5) * 2 * light.noise));
  }
  return { w: W, h: W, d };
}
const IDENT = { s: 1, th: 0, tx: 0, ty: 0 };
const POINTS = [
  { name: '左の穴', x: 0.30, y: 0.40, w: 0.14, h: 0.20 },
  { name: '右の穴', x: 0.58, y: 0.40, w: 0.14, h: 0.20 },
  { name: '先端', x: 0.77, y: 0.38, w: 0.17, h: 0.26 },
  { name: '背景(部品なし)', x: 0.05, y: 0.05, w: 0.2, h: 0.2 }
];
let fail = 0;
function check(name, cond, info) { console.log((cond ? 'OK  ' : 'FAIL') + ' ' + name + (info ? '  ' + info : '')); if (!cond) fail++; }

const master = Shape.prepare(scene('A', IDENT, { gain: 1, bias: 0, noise: 0 }, 1));
const LIGHT = { gain: 0.8, bias: 15, noise: 4 };
const shifts = [
  { s: 1, th: 0, tx: 0, ty: 0 },
  { s: 1.06, th: 5 * Math.PI / 180, tx: 14, ty: -10 },
  { s: 0.94, th: -9 * Math.PI / 180, tx: -20, ty: 16 },
  { s: 1.1, th: 14 * Math.PI / 180, tx: 25, ty: 20 }
];
shifts.forEach((tf, k) => {
  for (const variant of ['A', 'B']) {
    const t0 = Date.now();
    const shot = Shape.prepare(scene(variant, tf, LIGHT, 10 + k));
    const al = Shape.align(master, shot);
    const t1 = Date.now();
    const res = Shape.checkPoints(master, shot, al.P, POINTS);
    const t2 = Date.now();
    // 位置合わせの誤差：マスター上の点が正しい位置に移っているか
    const truth = (nx, ny) => { const c = (W - 1) / 2, rx = nx * W - c, ry = ny * W - c; return [(c + tf.s * (Math.cos(tf.th) * rx - Math.sin(tf.th) * ry) + tf.tx), (c + tf.s * (Math.sin(tf.th) * rx + Math.cos(tf.th) * ry) + tf.ty)]; };
    let err = 0;
    for (const [nx, ny] of [[0.3, 0.4], [0.7, 0.6], [0.5, 0.5]]) {
      const m = Shape.mapPoint(al.P, nx, ny), t = truth(nx, ny);
      err = Math.max(err, Math.hypot(m[0] * W - t[0], m[1] * W - t[1]));
    }
    console.log(`変換${k} 品${variant}: 位置合わせ ${al.score.toFixed(2)} 誤差${err.toFixed(1)}px (${t1 - t0}ms) / 比較 (${t2 - t1}ms) / ` + res.map((r, i) => POINTS[i].name + ' ' + r.score.toFixed(0)).join('  '));
    check(`  位置合わせの誤差が小さい(変換${k}${variant})`, err < 3.5, err.toFixed(1) + 'px');
    if (variant === 'A') check('  正しい品: 3つのポイントが高得点', res.slice(0, 3).every(r => r.score >= 70), res.slice(0, 3).map(r => r.score.toFixed(0)).join(','));
    else {
      check('  誤品: 左の穴は一致', res[0].score >= 70, res[0].score.toFixed(0));
      check('  誤品: 右の穴(形違い)が低得点', res[1].score < 70, res[1].score.toFixed(0));
      check('  誤品: 先端(形違い)が低得点', res[2].score < 55, res[2].score.toFixed(0));
    }
  }
});
// 全然違うもの（真っ白）は位置合わせの良さが低い
const blank = Shape.prepare({ w: W, h: W, d: new Float32Array(W * W).fill(200) });
const al = Shape.align(master, blank);
check('何も写っていない写真は位置合わせ失敗', al.score < 0.2, al.score.toFixed(2));
console.log(fail ? `\n${fail} 件失敗` : '\n全部OK');
process.exit(fail ? 1 : 0);
