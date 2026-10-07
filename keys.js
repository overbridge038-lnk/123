'use strict';
/* 照合キー方式の計算部分（画面には一切触れない「純粋な計算」だけ）
 *  1. analyze()    : 撮影の品質チェック（ピンぼけ・暗い・背景のむら・枠からはみ出し・部品なし・複数）と、部品の影絵(マスク)づくり
 *  2. prepare()    : 位置合わせや比較に使うデータ（明るさ正規化・影絵・重心）を作る
 *  3. align()      : 現品をマスターに位置合わせする（回転＋平行移動。大きさは補正しない）
 *  4. evaluate()   : キーごとの判定（形状・有無・刻印）と、総合判定（誤品を OK にしない設計）
 * 画像は { w, h, d: Float32Array(0〜255の明るさ) } という形で渡します。白い背景に黒い部品を真上から撮った写真が前提です。 */
(function (root) {
  const W = 320;                  // 計算に使う画像の一辺(px)
  const GUIDE = 0.06;             // 撮影ガイド枠の余白（一辺に対する比率）
  const FRAME_TOL = 0.02;         // ガイド枠からのはみ出しを許す幅
  const BG_MIN = 140;             // 背景の明るさがこれ未満なら「暗すぎる」
  const BG_MAX_WASH = 235;        // 背景がこれ以上で、部品との差が小さいなら「明るすぎる」
  const PART_MAX = 150;           // 黒い部品の平均の明るさがこれを超えたら「明るすぎる」
  const BLOWN_MAX = 0.2;          // 部品の中で白飛び(250以上)の画素がこの割合を超えたら「明るすぎる」
  const CONTRAST_MIN = 60;        // 背景と部品の明るさの差の下限
  const BG_STD_MAX = 18;          // 背景の明るさのばらつきの上限
  const BG_RANGE_MAX = 45;        // 背景の四隅の明るさの差の上限
  const SHARP_MIN = 0.17;         // 輪郭の鋭さの下限（0.5 = ぴったり、小さいほどぼやけ）
  const MIN_AREA = 0.015;         // 部品の面積の下限（画像に対する割合）
  const HOLE_BRIGHT = 0.85;       // 部品の中の明るい塊が、背景の明るさのこの割合以上なら「穴」（未満は反射として部品に含める）
  const SPECK = 12;               // これより小さい点（ノイズ・小さな反射）は無視する(px)
  const ALIGN_MIN = 0.80;         // 位置合わせの信頼度（影絵の重なり率 IoU）の下限
  const MIN_B = 6;                // 領域内の輪郭の画素数がこれ未満なら「輪郭なし」
  const TOL_B = 3;                // 輪郭どうしの距離がこの値(px)以内なら「重なっている」
  const ENG_MIN = 3;              // 刻印のコントラスト(標準偏差)の下限
  const EPS = 0.004;              // 輪郭がほぼ無い場所どうしを「同じ」とみなすための小さな値
  const SHIFT = 3, SHIFT_ENG = 4; // 比較で許す微小なずれ(px)
  const REGION_VALID_MIN = 0.98;  // キーの領域が現品の写真に入っている割合の下限
  const DEFAULT_TH = { shape: 80, presence: 60, engrave: 65 };   // 合格ライン（一致度 %）の標準値。実際の品物で必ず調整してください
  const BAND = { shape: 4, presence: 10, engrave: 8 };           // 合格ラインのすぐ下の「どちらとも言えない」幅（判定不能にする）
  const TYPES = { shape: '形状', presence: '有無', engrave: '刻印' };

  /* ---------- 画像の基本処理 ---------- */
  function blur3(src, w, h) {
    const t = new Float32Array(w * h), o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) {
        const xm = x > 0 ? x - 1 : x, xp = x < w - 1 ? x + 1 : x;
        t[r + x] = (src[r + xm] + 2 * src[r + x] + src[r + xp]) * 0.25;
      }
    }
    for (let y = 0; y < h; y++) {
      const ym = (y > 0 ? y - 1 : y) * w, yp = (y < h - 1 ? y + 1 : y) * w, r = y * w;
      for (let x = 0; x < w; x++) o[r + x] = (t[ym + x] + 2 * t[r + x] + t[yp + x]) * 0.25;
    }
    return o;
  }
  /** 四角い範囲の平均（半径 r）。端は端の値で延長 */
  function boxBlur(src, w, h, r) {
    const t = new Float32Array(w * h), o = new Float32Array(w * h), k = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w; let acc = 0;
      for (let i = -r; i <= r; i++) acc += src[row + Math.min(w - 1, Math.max(0, i))];
      for (let x = 0; x < w; x++) {
        t[row + x] = acc / k;
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += t[Math.min(h - 1, Math.max(0, i)) * w + x];
      for (let y = 0; y < h; y++) {
        o[y * w + x] = acc / k;
        acc += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
      }
    }
    return o;
  }
  function down2(src, w, h) {
    const nw = w >> 1, nh = h >> 1, o = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const i = (2 * y) * w + 2 * x;
      o[y * nw + x] = (src[i] + src[i + 1] + src[i + w] + src[i + w + 1]) * 0.25;
    }
    return o;
  }
  function sobel(src, w, h) {
    const o = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (src[i - w + 1] + 2 * src[i + 1] + src[i + w + 1]) - (src[i - w - 1] + 2 * src[i - 1] + src[i + w - 1]);
      const gy = (src[i + w - 1] + 2 * src[i + w] + src[i + w + 1]) - (src[i - w - 1] + 2 * src[i - w] + src[i - w + 1]);
      o[i] = Math.sqrt(gx * gx + gy * gy);
    }
    return o;
  }
  /** 輪郭の強さを「上位5%付近 = 1」にそろえる（全体の明るさに左右されない） */
  function normEdge(e, valid) {
    let max = 0;
    for (let i = 0; i < e.length; i++) if (e[i] > max) max = e[i];
    if (max <= 0) return e;
    const bins = new Uint32Array(512); let n = 0;
    for (let i = 0; i < e.length; i++) if (!valid || valid[i]) { bins[Math.min(511, (e[i] / max * 511) | 0)]++; n++; }
    let acc = 0, p95 = max;
    for (let b = 0; b < 512; b++) { acc += bins[b]; if (acc >= n * 0.95) { p95 = (b + 1) / 512 * max; break; } }
    const s = 1 / Math.max(p95, 0.15 * max);
    const o = new Float32Array(e.length);
    for (let i = 0; i < e.length; i++) o[i] = e[i] * s;
    return o;
  }
  function otsu(d) {
    const hist = new Float64Array(256), n = d.length;
    for (let i = 0; i < n; i++) hist[Math.max(0, Math.min(255, d[i] | 0))]++;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let wB = 0, sumB = 0, max = -1, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = n - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > max) { max = v; thr = t; }
    }
    return thr + 1;                                   // 明るさ < thr を「暗い（部品）」とする
  }
  const median = a => { const s = Float32Array.from(a).sort(); return s.length ? s[s.length >> 1] : 0; };

  /** target と同じ値でつながっている画素のかたまり（上下左右）に番号を付ける */
  function label(mask, w, h, target) {
    const n = w * h, lab = new Int32Array(n), comps = [], stack = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      if (mask[s] !== target || lab[s]) continue;
      const id = comps.length + 1;
      let sp = 0, area = 0, minx = w, miny = h, maxx = -1, maxy = -1;
      stack[sp++] = s; lab[s] = id;
      while (sp) {
        const i = stack[--sp], x = i % w, y = (i / w) | 0;
        area++;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x > 0 && mask[i - 1] === target && !lab[i - 1]) { lab[i - 1] = id; stack[sp++] = i - 1; }
        if (x < w - 1 && mask[i + 1] === target && !lab[i + 1]) { lab[i + 1] = id; stack[sp++] = i + 1; }
        if (y > 0 && mask[i - w] === target && !lab[i - w]) { lab[i - w] = id; stack[sp++] = i - w; }
        if (y < h - 1 && mask[i + w] === target && !lab[i + w]) { lab[i + w] = id; stack[sp++] = i + w; }
      }
      comps.push({ id, area, minx, miny, maxx, maxy, border: minx === 0 || miny === 0 || maxx === w - 1 || maxy === h - 1 });
    }
    return { lab, comps };
  }

  /* ---------- 1. 撮影の品質チェック ---------- */
  /** gray: { w, h, d }。opts.expectComps = マスターの部品のかたまりの数（これより多いと「複数」）
   *  戻り値: { ok, issues:[{code, msg}], m:{…測定値}, mask, thr, bg, comps } */
  function analyze(gray, opts) {
    opts = opts || {};
    const w = gray.w, h = gray.h, d = gray.d, n = w * h, issues = [];
    const add = (code, msg) => issues.push({ code, msg });
    // 背景の明るさ：画像のふち（外側5%）の中央値
    const ring = [], rw = Math.max(2, Math.round(w * 0.05)), rh = Math.max(2, Math.round(h * 0.05));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < rw || y < rh || x >= w - rw || y >= h - rh) ring.push(d[y * w + x]);
    const bg = median(ring);
    const m = { bg: Math.round(bg), contrast: 0, sharp: 0, bgStd: 0, bgRange: 0, area: 0, comps: 0, bbox: null };
    let thr = otsu(d);
    thr = Math.max(40, Math.min(thr, bg - 35));
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = d[i] < thr ? 1 : 0;
    // ノイズ除去：小さな暗い点を消し、部品の中の小さな明るい点（反射）を埋める
    let L = label(raw, w, h, 1);
    for (const c of L.comps) if (c.area < SPECK) for (let i = 0; i < n; i++) if (L.lab[i] === c.id) raw[i] = 0;
    L = label(raw, w, h, 0);
    // 部品の中の明るい塊：背景が透けて見える「穴」なら残し、小さいもの・背景ほど白くないもの（反射・ハイライト）は部品として埋める
    const sumB = new Float64Array(L.comps.length + 1);
    for (let i = 0; i < n; i++) if (L.lab[i]) sumB[L.lab[i]] += d[i];
    const fill = new Uint8Array(L.comps.length + 1);
    for (const c of L.comps) if (!c.border && (c.area < SPECK || sumB[c.id] / c.area < HOLE_BRIGHT * bg)) fill[c.id] = 1;
    for (let i = 0; i < n; i++) if (L.lab[i] && fill[L.lab[i]]) raw[i] = 1;
    L = label(raw, w, h, 1);
    const largest = L.comps.reduce((a, c) => Math.max(a, c.area), 0);
    const sig = L.comps.filter(c => c.area >= 0.003 * n);       // 画像の0.3%以上のかたまりを「部品」と数える
    const sigIds = new Set(sig.map(c => c.id));
    const mask = new Uint8Array(n);
    let area = 0, sumG = 0, blown = 0;
    for (let i = 0; i < n; i++) if (sigIds.has(L.lab[i])) { mask[i] = 1; area++; sumG += d[i]; if (d[i] >= 250) blown++; }
    m.area = area / n; m.comps = sig.length;
    if (bg < BG_MIN) add('dark', `暗すぎます（背景の明るさ ${m.bg}）。照明を明るくするか、白い紙・ライトボックスの上で撮ってください`);
    if (largest < MIN_AREA * n) {
      add('none', '部品が写っていません。白い背景の上に部品を置いて撮ってください');
      return { ok: false, issues, m, mask, thr, bg, comps: 0 };
    }
    m.contrast = Math.round(bg - sumG / area);
    m.blown = Math.round(blown / area * 1000) / 1000;
    if (bg >= BG_MIN && (sumG / area > PART_MAX || m.blown > BLOWN_MAX)) {
      add('bright', `明るすぎます（部品の明るさ ${Math.round(sumG / area)}・白飛び ${(m.blown * 100).toFixed(0)}%）。照明を弱めるか、カメラの露出を下げてください`);
    } else if (bg >= BG_MIN && m.contrast < CONTRAST_MIN) {
      if (bg >= BG_MAX_WASH) add('bright', `明るすぎます（背景 ${m.bg}・部品との差 ${m.contrast}）。照明を弱めるか、カメラの露出を下げてください`);
      else add('contrast', `部品と背景の明るさの差が小さすぎます（${m.contrast}）。白い背景の上に置いて撮ってください`);
    }
    // 背景のむら：部品から少し離れた背景の画素のばらつきと、四隅の明るさの差
    const near = boxBlur(Float32Array.from(mask), w, h, 4), bgVals = [];
    for (let i = 0; i < n; i++) if (near[i] < 0.001 && d[i] >= thr) bgVals.push(d[i]);
    if (bgVals.length > n * 0.1) {
      let s = 0; for (const v of bgVals) s += v;
      const mean = s / bgVals.length; let v2 = 0; for (const v of bgVals) v2 += (v - mean) * (v - mean);
      m.bgStd = Math.round(Math.sqrt(v2 / bgVals.length) * 10) / 10;
      const bw = Math.round(w * 0.12), bh = Math.round(h * 0.12), cm = [];
      for (const [x0, y0] of [[0, 0], [w - bw, 0], [0, h - bh], [w - bw, h - bh]]) {
        let a = 0, c = 0;
        for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) { const i = y * w + x; if (near[i] < 0.001 && d[i] >= thr) { a += d[i]; c++; } }
        if (c > bw * bh * 0.3) cm.push(a / c);
      }
      m.bgRange = cm.length >= 2 ? Math.round(Math.max(...cm) - Math.min(...cm)) : 0;
      if (m.bgStd > BG_STD_MAX || m.bgRange > BG_RANGE_MAX) add('bgnoise', `背景が一様ではありません（ばらつき ${m.bgStd}・四隅の差 ${m.bgRange}）。無地の白い背景にしてください`);
    }
    // ピンぼけ：部品の輪郭の鋭さ（輪郭での明るさの変化の大きさ ÷ 部品と背景の差）
    if (m.contrast > 20) {
      const gs = blur3(d, w, h), grads = [];                    // 軽くならしてノイズの影響を減らす
      for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        if (mask[i - 1] && mask[i + 1] && mask[i - w] && mask[i + w]) continue;   // 輪郭の画素だけ
        let best = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const j = i + dy * w + dx;
          const gx = (gs[j + 1] - gs[j - 1]) * 0.5, gy = (gs[j + w] - gs[j - w]) * 0.5, g = Math.sqrt(gx * gx + gy * gy);
          if (g > best) best = g;
        }
        grads.push(best);
      }
      m.sharp = grads.length ? Math.round(median(grads) / m.contrast * 1000) / 1000 : 0;
      if (m.sharp < SHARP_MIN) add('blur', `ピンぼけです（鋭さ ${m.sharp.toFixed(2)}・基準 ${SHARP_MIN}以上）。ピントを合わせ、カメラを動かさずに撮ってください`);
    }
    // 枠からはみ出し
    let minx = w, miny = h, maxx = -1, maxy = -1;
    for (const c of sig) { minx = Math.min(minx, c.minx); miny = Math.min(miny, c.miny); maxx = Math.max(maxx, c.maxx); maxy = Math.max(maxy, c.maxy); }
    m.bbox = [minx / w, miny / h, (maxx + 1) / w, (maxy + 1) / h].map(v => Math.round(v * 1000) / 1000);
    const lo = GUIDE - FRAME_TOL, hi = 1 - GUIDE + FRAME_TOL;
    if (sig.some(c => c.border) || m.bbox[0] < lo || m.bbox[1] < lo || m.bbox[2] > hi || m.bbox[3] > hi) {
      add('frame', '部品が枠からはみ出しています。ガイド枠の中に収めて撮ってください');
    }
    // 部品が複数
    const expect = opts.expectComps || 1;
    if (sig.length > expect) add('multi', `部品が複数写っています（${sig.length}個）。撮影台には1つだけ置いてください`);
    return { ok: !issues.length, issues, m, mask, thr, bg, comps: sig.length };
  }

  /* ---------- 2. 位置合わせ・比較に使うデータ ---------- */
  /** gray と analyze() の結果から、比較用のデータを作る（明るさは背景=255 にそろえる） */
  function prepare(gray, an) {
    const w = gray.w, h = gray.h, n = w * h, k = 255 / Math.max(1, an.bg);
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = Math.min(255, gray.d[i] * k);
    const mf = Float32Array.from(an.mask), soft = blur3(blur3(mf, w, h), w, h);
    let sx = 0, sy = 0, cnt = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (an.mask[y * w + x]) { sx += x; sy += y; cnt++; }
    return { w, h, g, mask: an.mask, soft, cx: cnt ? sx / cnt : w / 2, cy: cnt ? sy / cnt : h / 2, area: cnt, valid: null, an };
  }

  /* ---------- 3. 位置合わせ（回転＋平行移動） ----------
   * 変換 P = { th, tx, ty }：マスターの画素 p → 現品の画素 q = cs + t + R(th)·(p − cm)（cm, cs はそれぞれの重心） */
  function level(prep, lvl) {      // lvl 0 = 320px、1 = 160px
    if (lvl === 0) return { w: prep.w, h: prep.h, soft: prep.soft, cx: prep.cx, cy: prep.cy, f: 1 };
    const w = prep.w >> 1, h = prep.h >> 1;
    return { w, h, soft: down2(prep.soft, prep.w, prep.h), cx: prep.cx / 2 - 0.25, cy: prep.cy / 2 - 0.25, f: 0.5 };
  }
  function pixelList(L, stride) {
    const xs = [], ys = [], mv = []; let sum = 0;
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const v = L.soft[y * L.w + x];
      sum += v;
      if (v > 0.02 && (y % stride === 0)) { xs.push(x); ys.push(y); mv.push(v); }
    }
    return { xs: Float32Array.from(xs), ys: Float32Array.from(ys), mv: Float32Array.from(mv), sum, stride };
  }
  /** 重なりの量 Σ min(m, s)（なめらかな影絵どうし） */
  function overlap(Lm, Ls, list, th, tx, ty) {
    const c = Math.cos(th), s = Math.sin(th), w = Ls.w, h = Ls.h, S = Ls.soft;
    const ox = Ls.cx + tx - c * Lm.cx + s * Lm.cy, oy = Ls.cy + ty - s * Lm.cx - c * Lm.cy;
    let sum = 0;
    for (let k = 0; k < list.xs.length; k++) {
      const x = list.xs[k], y = list.ys[k];
      const qx = ox + c * x - s * y, qy = oy + s * x + c * y;
      if (qx < 0 || qy < 0 || qx > w - 1.001 || qy > h - 1.001) continue;
      const x0 = qx | 0, y0 = qy | 0, fx = qx - x0, fy = qy - y0, i = y0 * w + x0;
      const v = S[i] * (1 - fx) * (1 - fy) + S[i + 1] * fx * (1 - fy) + S[i + w] * (1 - fx) * fy + S[i + w + 1] * fx * fy;
      sum += Math.min(list.mv[k], v);
    }
    return sum * list.stride;
  }
  const iouOf = (I, Am, As) => I / Math.max(1e-9, Am + As - I);

  function refine(Lm, Ls, list, As, P, sched) {
    let best = iouOf(overlap(Lm, Ls, list, P[0], P[1], P[2]), list.sum, As);
    for (const [ts, as] of sched) {
      for (let it = 0; it < 30; it++) {
        let bp = null, bv = best;
        for (const mv of [[0, ts, 0], [0, -ts, 0], [0, 0, ts], [0, 0, -ts], [as, 0, 0], [-as, 0, 0]]) {
          const q = [P[0] + mv[0], P[1] + mv[1], P[2] + mv[2]];
          const v = iouOf(overlap(Lm, Ls, list, q[0], q[1], q[2]), list.sum, As);
          if (v > bv + 1e-6) { bv = v; bp = q; }
        }
        if (!bp) break;
        P = bp; best = bv;
      }
    }
    return { P, v: best };
  }
  const D2R = Math.PI / 180;

  /** 現品をマスターに位置合わせする。戻り値: { P:{th,tx,ty,cmx,cmy,csx,csy}, conf(0〜1 = 影絵の重なり率) } */
  function align(M, S) {
    if (!M.area || !S.area) return { P: { th: 0, tx: 0, ty: 0, cmx: M.cx, cmy: M.cy, csx: S.cx, csy: S.cy }, conf: 0 };
    const M1 = level(M, 1), S1 = level(S, 1), l1 = pixelList(M1, 1);
    let As1 = 0; for (let i = 0; i < S1.soft.length; i++) As1 += S1.soft[i];
    // ① 小さい画像で、向き（0〜360°）を総当たり（重心を合わせたまま回す）
    const N = 72, vals = [];
    for (let k = 0; k < N; k++) vals.push(iouOf(overlap(M1, S1, l1, k * 5 * D2R, 0, 0), l1.sum, As1));
    const top = Math.max(...vals), cands = [];
    for (let k = 0; k < N; k++) if (vals[k] >= vals[(k + N - 1) % N] && vals[k] >= vals[(k + 1) % N] && vals[k] >= top - 0.08) cands.push({ th: k * 5 * D2R, v: vals[k] });
    cands.sort((a, b) => b.v - a.v);
    // ② 候補を磨く（粗い段 → 細かい段）
    const M0 = level(M, 0), S0 = level(S, 0), l0 = pixelList(M0, 2);
    let As0 = 0; for (let i = 0; i < S0.soft.length; i++) As0 += S0.soft[i];
    const refined = [];
    for (const c of cands.slice(0, 3)) {
      const r1 = refine(M1, S1, l1, As1, [c.th, 0, 0], [[3, 4 * D2R], [1.5, 2 * D2R], [0.75, 1 * D2R]]);
      const r0 = refine(M0, S0, l0, As0, [r1.P[0], r1.P[1] * 2, r1.P[2] * 2], [[1.5, 0.8 * D2R], [0.75, 0.4 * D2R], [0.375, 0.2 * D2R]]);
      refined.push({ P: r0.P, v: r0.v });
    }
    refined.sort((a, b) => b.v - a.v);
    const mk = r => ({ th: r.P[0], tx: r.P[1], ty: r.P[2], cmx: M.cx, cmy: M.cy, csx: S.cx, csy: S.cy });
    let pick = refined[0];
    // ③ 向きが似た点対称の形などで、重なり率がほぼ同じ候補が複数あるときは、写真の輪郭の一致で決める
    const close = refined.filter(r => r.v >= pick.v - 0.03);
    if (close.length > 1) {
      let bs = -1;
      for (const r of close) {
        const z = edgeCorr(M, S, mk(r)), sc = r.v + 0.3 * Math.max(0, z);
        if (sc > bs) { bs = sc; pick = r; }
      }
    }
    const P = mk(pick);
    return { P, conf: hardIoU(M, S, P) };
  }
  function toShot(P, x, y) {
    const c = Math.cos(P.th), s = Math.sin(P.th), px = x - P.cmx, py = y - P.cmy;
    return [P.csx + P.tx + c * px - s * py, P.csy + P.ty + s * px + c * py];
  }
  /** 位置合わせの良さ：影絵の重なり率(IoU)。なめらかな影絵の 0.5 を境にして数える */
  function hardIoU(M, S, P) {
    const w = S.w, h = S.h; let I = 0, Am = 0, As = S.area;
    for (let y = 0; y < M.h; y++) for (let x = 0; x < M.w; x++) {
      if (!M.mask[y * M.w + x]) continue;
      Am++;
      const [qx, qy] = toShot(P, x, y);
      if (qx < 0 || qy < 0 || qx > w - 1.001 || qy > h - 1.001) continue;
      const x0 = qx | 0, y0 = qy | 0, fx = qx - x0, fy = qy - y0, i = y0 * w + x0, T = S.soft;
      const v = T[i] * (1 - fx) * (1 - fy) + T[i + 1] * fx * (1 - fy) + T[i + w] * (1 - fx) * fy + T[i + w + 1] * fx * fy;
      if (v >= 0.5) I++;
    }
    return iouOf(I, Am, As);
  }
  /** 現品をマスターの座標に変形する（範囲外は背景=255 で埋める） */
  function warp(S, P) {
    const w = S.w, h = S.h, n = w * h, g = new Float32Array(n), soft = new Float32Array(n), valid = new Uint8Array(n);
    const c = Math.cos(P.th), s = Math.sin(P.th);
    const ox = P.csx + P.tx - c * P.cmx + s * P.cmy, oy = P.csy + P.ty - s * P.cmx - c * P.cmy;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = y * w + x, qx = ox + c * x - s * y, qy = oy + s * x + c * y;
      if (qx < 0 || qy < 0 || qx > w - 1.001 || qy > h - 1.001) { g[o] = 255; continue; }
      const x0 = qx | 0, y0 = qy | 0, fx = qx - x0, fy = qy - y0, i = y0 * w + x0;
      const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), cc = (1 - fx) * fy, dd = fx * fy;
      g[o] = S.g[i] * a + S.g[i + 1] * b + S.g[i + w] * cc + S.g[i + w + 1] * dd;
      soft[o] = S.soft[i] * a + S.soft[i + 1] * b + S.soft[i + w] * cc + S.soft[i + w + 1] * dd;
      valid[o] = 1;
    }
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = soft[i] >= 0.5 ? 1 : 0;
    return { w, h, g, mask, soft, valid };
  }

  /* ---------- 4. 比較に使う特徴（必要になったとき1回だけ作る） ---------- */
  function feat(v) {
    if (v.edge) return v;
    const w = v.w, h = v.h, n = w * h, gs = blur3(v.g, w, h);
    v.edge = normEdge(blur3(sobel(gs, w, h), w, h), v.valid);
    const lp = boxBlur(gs, w, h, 4); v.hp = new Float32Array(n);
    for (let i = 0; i < n; i++) v.hp[i] = gs[i] - lp[i];
    const bnd = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!v.mask[i]) continue;
      if ((x > 0 && !v.mask[i - 1]) || (x < w - 1 && !v.mask[i + 1]) || (y > 0 && !v.mask[i - w]) || (y < h - 1 && !v.mask[i + w])) bnd[i] = 1;
    }
    v.bnd = bnd;
    const dist = new Float32Array(n).fill(1e9);        // 輪郭までの距離（1/3 px 単位の面取り距離）
    for (let i = 0; i < n; i++) if (bnd[i]) dist[i] = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; let a = dist[i];
      if (x > 0) a = Math.min(a, dist[i - 1] + 3);
      if (y > 0) { a = Math.min(a, dist[i - w] + 3); if (x > 0) a = Math.min(a, dist[i - w - 1] + 4); if (x < w - 1) a = Math.min(a, dist[i - w + 1] + 4); }
      dist[i] = a;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x; let a = dist[i];
      if (x < w - 1) a = Math.min(a, dist[i + 1] + 3);
      if (y < h - 1) { a = Math.min(a, dist[i + w] + 3); if (x < w - 1) a = Math.min(a, dist[i + w + 1] + 4); if (x > 0) a = Math.min(a, dist[i + w - 1] + 4); }
      dist[i] = a;
    }
    v.dist = dist;
    return v;
  }
  /** 位置合わせの候補を選ぶための、写真全体の輪郭の相関（-1〜1） */
  function edgeCorr(M, S, P) {
    const wp = warp(S, P); wp.edge = null;
    feat(M); feat(wp);
    let n = 0, sA = 0, sB = 0, sAA = 0, sBB = 0, sAB = 0;
    for (let i = 0; i < M.edge.length; i++) {
      if (!wp.valid[i] || !(M.mask[i] || wp.mask[i])) continue;
      const a = M.edge[i], b = wp.edge[i]; n++; sA += a; sB += b; sAA += a * a; sBB += b * b; sAB += a * b;
    }
    if (n < 50) return 0;
    const mA = sA / n, mB = sB / n, vA = sAA / n - mA * mA, vB = sBB / n - mB * mB;
    return vA < 1e-9 || vB < 1e-9 ? 0 : (sAB / n - mA * mB) / Math.sqrt(vA * vB);
  }

  /* ---------- 5. キーごとの測定 ---------- */
  function rectOf(key, w, h) {
    const x0 = Math.max(0, Math.min(w - 4, Math.round(key.x * w))), y0 = Math.max(0, Math.min(h - 4, Math.round(key.y * h)));
    return { x0, y0, x1: Math.max(x0 + 4, Math.min(w, Math.round((key.x + key.w) * w))), y1: Math.max(y0 + 4, Math.min(h, Math.round((key.y + key.h) * h))) };
  }
  function sdOf(arr, w, rc) {
    let n = 0, s = 0, ss = 0;
    for (let y = rc.y0; y < rc.y1; y++) for (let x = rc.x0; x < rc.x1; x++) { const v = arr[y * w + x]; n++; s += v; ss += v * v; }
    const m = s / n; return Math.sqrt(Math.max(0, ss / n - m * m));
  }
  /** 領域内の2つの画像の相関（-1〜1）。わずかなずれ(±shift px)は許して、最もよく合うところを返す */
  function bestCorr(A, B, w, h, rc, shift, eps) {
    const n = (rc.x1 - rc.x0) * (rc.y1 - rc.y0);
    let sA = 0, sAA = 0;
    for (let y = rc.y0; y < rc.y1; y++) for (let x = rc.x0; x < rc.x1; x++) { const v = A[y * w + x]; sA += v; sAA += v * v; }
    const mA = sA / n, vA = sAA / n - mA * mA;
    let best = -1;
    for (let dy = -shift; dy <= shift; dy++) for (let dx = -shift; dx <= shift; dx++) {
      let sB = 0, sBB = 0, sAB = 0;
      for (let y = rc.y0; y < rc.y1; y++) {
        const yy = y + dy, inY = yy >= 0 && yy < h;
        for (let x = rc.x0; x < rc.x1; x++) {
          const xx = x + dx, v = (inY && xx >= 0 && xx < w) ? B[yy * w + xx] : 0, u = A[y * w + x];
          sB += v; sBB += v * v; sAB += u * v;
        }
      }
      const mB = sB / n, vB = sBB / n - mB * mB, cov = sAB / n - mA * mB;
      const z = (cov + eps) / Math.sqrt((vA + eps) * (vB + eps));
      if (z > best) best = z;
    }
    return best;
  }
  /** 形状：領域内の輪郭どうしの重なり（再現率と適合率の小さいほう）。輪郭が無い領域は面積の重なり */
  function measureShape(Mv, Sv, rc) {
    const w = Mv.w; let nm = 0, ns = 0, hitM = 0, hitS = 0;
    const lim = TOL_B * 3;
    for (let y = rc.y0; y < rc.y1; y++) for (let x = rc.x0; x < rc.x1; x++) {
      const i = y * w + x;
      if (Mv.bnd[i]) { nm++; if (Sv.dist[i] <= lim) hitM++; }
      if (Sv.bnd[i]) { ns++; if (Mv.dist[i] <= lim) hitS++; }
    }
    if (nm < MIN_B && ns < MIN_B) {
      let I = 0, U = 0;
      for (let y = rc.y0; y < rc.y1; y++) for (let x = rc.x0; x < rc.x1; x++) { const i = y * w + x, a = Mv.mask[i], b = Sv.mask[i]; I += a & b; U += a | b; }
      const iou = U ? I / U : 1;
      return { score: iou * 100, detail: `輪郭なし・面積の重なり ${(iou * 100).toFixed(0)}%` };
    }
    const rec = nm ? hitM / nm : 1, pre = ns ? hitS / ns : 1;
    return { score: Math.min(rec, pre) * 100, detail: `再現 ${(rec * 100).toFixed(0)}%・適合 ${(pre * 100).toFixed(0)}%` };
  }
  function measureKey(key, Mv, Sv) {
    const rc = rectOf(key, Mv.w, Mv.h), w = Mv.w;
    let inside = 0;
    for (let y = rc.y0; y < rc.y1; y++) for (let x = rc.x0; x < rc.x1; x++) inside += Sv.valid[y * w + x];
    if (inside / ((rc.x1 - rc.x0) * (rc.y1 - rc.y0)) < REGION_VALID_MIN) return { valid: false, score: 0, why: '領域が現品の写真の範囲外です' };
    if (key.type === 'shape') {
      const r = measureShape(Mv, Sv, rc);
      return { valid: true, score: r.score, detail: r.detail };
    }
    if (key.type === 'presence') {
      const z = Math.max(0, Math.min(1, bestCorr(Mv.edge, Sv.edge, w, Mv.h, rc, SHIFT, EPS))) * 100;
      const s = measureShape(Mv, Sv, rc);
      const hasB = !/輪郭なし/.test(s.detail);
      return { valid: true, score: hasB ? Math.min(z, s.score) : z, detail: `輪郭の一致 ${z.toFixed(0)}%` + (hasB ? `・形 ${s.score.toFixed(0)}%` : '') };
    }
    if (key.type === 'engrave') {
      const cm = sdOf(Mv.hp, w, rc), cs = sdOf(Sv.hp, w, rc);
      if (cm < ENG_MIN) return { valid: false, score: 0, why: 'マスターのこの領域に刻印のコントラストがありません（領域を描き直してください）' };
      if (cs < Math.max(ENG_MIN, 0.4 * cm)) return { valid: false, score: 0, why: '刻印が見えない、または不鮮明です（照明と置き方を確認して撮り直してください）', detail: `刻印のコントラスト ${cs.toFixed(1)}（マスター ${cm.toFixed(1)}）` };
      const z = Math.max(0, Math.min(1, bestCorr(Mv.hp, Sv.hp, w, Mv.h, rc, SHIFT_ENG, 1e-6)));
      return { valid: true, score: z * 100, detail: `刻印の形の一致 ${(z * 100).toFixed(0)}%（コントラスト ${cs.toFixed(1)}／マスター ${cm.toFixed(1)}）` };
    }
    return { valid: false, score: 0, why: '未対応のキーの種類です' };
  }
  const thOf = k => (typeof k.th === 'number' ? k.th : DEFAULT_TH[k.type] || 70);
  /** 測定値 → 'ok' | 'ng' | 'unk'。合格ラインのすぐ下（BAND）は「どちらとも言えない」ので判定不能 */
  function stateOf(key, m) {
    if (!m.valid || !Number.isFinite(m.score)) return 'unk';
    const th = thOf(key);
    if (m.score >= th) return 'ok';
    return m.score < th - (BAND[key.type] || 0) ? 'ng' : 'unk';
  }

  /** 総合判定。必須キーがすべて OK のときだけ OK。必須の NG が1つでもあれば NG。それ以外（計算できない等）は判定不能 */
  function aggregate(items) {
    const must = items.filter(i => i.must);
    if (!must.length) return { result: 'UNK', reason: '必須のキーがありません（すべて「参考」になっています）。登録タブで「必須」にしてください' };
    const ng = must.filter(i => i.state === 'ng'), unk = must.filter(i => i.state === 'unk');
    if (ng.length) return { result: 'NG', reason: '必須キーがNG：' + ng.map(i => i.name).join('、') };
    if (unk.length) return { result: 'UNK', reason: '判定できないキーがあります：' + unk.map(i => i.name + (i.why ? '（' + i.why + '）' : '（境界値）')).join('、') };
    return { result: 'OK', reason: '必須キーがすべてOK' };
  }

  /* ---------- 6. 判定の本体 ----------
   * masters: [{ id, prep, an, keys:[{id,name,type,x,y,w,h,must,th?,exp?}] }]（keys が空のものは使わない）
   * 戻り値: { result:'OK'|'NG'|'UNK', reason, quality, issues, conf, masterId, items, P } 例外は投げず、失敗は必ず UNK にする */
  function evaluate(masters, shotGray) {
    const base = { result: 'UNK', reason: '', quality: null, issues: [], conf: 0, masterId: null, items: [], P: null };
    try {
      const use = masters.filter(m => m.keys && m.keys.length);
      if (!use.length) return Object.assign(base, { reason: '照合キーが登録されていません' });
      const expectComps = Math.min(...use.map(m => m.an.comps || 1));
      const an = analyze(shotGray, { expectComps });
      base.quality = an.m; base.issues = an.issues;
      if (!an.ok) return Object.assign(base, { reason: '撮影の状態が不適切です：' + an.issues.map(i => i.msg).join(' / ') });
      const S = prepare(shotGray, an);
      let best = null;
      for (const m of use) {
        const al = align(m.prep, S);
        if (!best || al.conf > best.al.conf) best = { m, al };
      }
      base.masterId = best.m.id; base.conf = best.al.conf; base.P = best.al.P;
      if (!(best.al.conf >= ALIGN_MIN)) return Object.assign(base, { reason: `位置合わせの信頼度が低い（${(best.al.conf * 100).toFixed(0)}%・基準 ${ALIGN_MIN * 100}%）。部品を撮影台の同じ位置に置いて撮り直してください` });
      const Mv = feat(best.m.prep), Sv = feat(warp(S, best.al.P));
      const items = best.m.keys.map(key => {
        let r;
        try { r = measureKey(key, Mv, Sv); } catch (e) { r = { valid: false, score: 0, why: '計算に失敗しました（' + ((e && e.message) || e) + '）' }; }
        const state = stateOf(key, r), th = thOf(key);
        const rect = { x: key.x, y: key.y, w: key.w, h: key.h };
        const quad = [[key.x, key.y], [key.x + key.w, key.y], [key.x + key.w, key.y + key.h], [key.x, key.y + key.h]]
          .map(([x, y]) => { const q = toShot(best.al.P, x * W, y * W); return [q[0] / W, q[1] / W]; });
        const it = {
          id: key.id, name: key.name, type: key.type, must: key.must !== false, th, state,
          score: Math.round((r.score || 0) * 10) / 10, why: r.why || '', detail: r.detail || '', rect, quad
        };
        if (key.type === 'presence') {
          const exp = key.exp ? key.exp.present !== false : true;
          it.exp = exp ? 'あり' : 'なし';
          it.obs = state === 'ok' ? it.exp : state === 'ng' ? (exp ? 'なし' : 'あり') : '不明';
        }
        return it;
      });
      base.items = items;
      const ag = aggregate(items);
      base.result = ag.result; base.reason = ag.reason;
      return base;
    } catch (e) {
      base.result = 'UNK'; base.reason = '判定中にエラーが発生しました：' + ((e && e.message) || e);
      base.error = e;
      return base;
    }
  }

  /* ---------- 7. 設定画面の補助 ---------- */
  /** マスターの領域の様子（期待値の自動取得と、判別に効かない領域の警告に使う） */
  function describeRegion(M, key) {
    const v = feat(M), rc = rectOf(key, M.w, M.h), w = M.w;
    let fg = 0, nb = 0; const n = (rc.x1 - rc.x0) * (rc.y1 - rc.y0);
    for (let y = rc.y0; y < rc.y1; y++) for (let x = rc.x0; x < rc.x1; x++) { const i = y * w + x; fg += v.mask[i]; nb += v.bnd[i]; }
    const edge = sdOf(v.edge, w, rc), contrast = sdOf(v.hp, w, rc);
    const info = { fg: fg / n, boundary: nb, edge, contrast, hasOutline: nb >= MIN_B };
    if (key.type === 'shape') info.warn = info.hasOutline ? '' : '輪郭（部品の縁・穴・切り欠き）が入っていません。形を見分けたい縁や穴を含めてください';
    else if (key.type === 'engrave') info.warn = contrast >= ENG_MIN ? '' : '刻印のコントラストが見えません。刻印が写っている場所に合わせてください（斜めからの拡散光で撮り直すと見えやすくなります）';
    else info.warn = '';
    info.present = !(info.fg < 0.03 && edge < 0.08);       // 影絵にも輪郭にも何も無い領域だけ「ない」と推定する
    return info;
  }

  const api = {
    WORK: W, GUIDE, ALIGN_MIN, DEFAULT_TH, BAND, TYPES, SHARP_MIN, ENG_MIN,
    analyze, prepare, align, warp, feat, measureKey, stateOf, aggregate, evaluate, describeRegion, thOf, toShot
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Keys = api;
})(typeof self !== 'undefined' ? self : this);
