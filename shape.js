'use strict';
/* 形状照合（検査ポイント方式）の計算部分。画面には一切触れない「純粋な計算」だけを入れています。
 *  1. prepare()      : 写真（白黒）から、位置合わせ用の輪郭(エッジ)画像を作る
 *  2. align()        : 現品の写真をマスターに位置合わせする（拡大縮小・回転・平行移動）
 *  3. checkPoints()  : 位置合わせ後、ポイントごとに輪郭の一致度(0〜100)を計算する
 * 色は使わず、輪郭（明るさの急な変化）だけを比べます。
 * 画像は { w, h, d: Float32Array(0〜255の明るさ) } という形で渡します。 */
(function (root) {
  const WORK = 384;            // 計算に使う画像の一辺(px)
  const LEVELS = 4;            // 384 → 192 → 96 → 48
  const COARSE = LEVELS - 1;
  const MIN_COVER = 0.55;      // 位置合わせ後に、重なっている面積がこれ未満なら失敗扱い
  const EPS = 0.004;           // 輪郭がほぼ無い場所どうしを「同じ」とみなすための小さな値
  const SHIFT = 3;             // ポイント比較で許す微小なずれ(px)

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
  function down2(src, w, h) {
    const nw = w >> 1, nh = h >> 1, o = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      const i = (2 * y) * w + 2 * x;
      o[y * nw + x] = (src[i] + src[i + 1] + src[i + w] + src[i + w + 1]) * 0.25;
    }
    return o;
  }
  /** ソーベルフィルタによる輪郭の強さ */
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
  function centralDiff(e, w, h) {
    const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = (e[i + 1] - e[i - 1]) * 0.5; gy[i] = (e[i + w] - e[i - w]) * 0.5;
    }
    return { gx, gy };
  }
  /** 全体の明るさの違いに左右されないよう、輪郭の強さを「上位5%付近 = 1」にそろえる */
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

  /** gray: { w, h, d } → 位置合わせ用のピラミッド（細かい順に4段） */
  function prepare(gray) {
    let g = gray.d, w = gray.w, h = gray.h;
    const levels = [];
    for (let l = 0; l < LEVELS; l++) {
      const e = blur3(sobel(blur3(g, w, h), w, h), w, h);
      const { gx, gy } = centralDiff(e, w, h);
      levels.push({ w, h, e, gx, gy });
      if (l < LEVELS - 1) { g = down2(g, w, h); w >>= 1; h >>= 1; }
    }
    return { gray, levels, cmp: null };
  }

  /* ---------- 位置合わせ ----------
   * 変換 P = [tx, ty, a, b] : マスターの点(x,y) → 現品の点
   *   sx = cx + (1+a)·rx − b·ry + tx,  sy = cy + b·rx + (1+a)·ry + ty   （rx,ry は中心からの距離）
   * (1+a, b) = 倍率×(cosθ, sinθ) なので、拡大縮小・回転・平行移動を表せます。 */
  const scratch = {};
  function buf(n, k) {
    const key = n + ':' + k;
    if (!scratch[key]) scratch[key] = { t: new Float32Array(n), v: new Float32Array(n), gx: new Float32Array(n), gy: new Float32Array(n), rx: new Float32Array(n), ry: new Float32Array(n), n: 0 };
    return scratch[key];
  }

  /** 位置合わせの良さ（ZNCC: -1〜1）。b を渡すと、あとで使う値も保存する */
  function stats(T, S, P, b) {
    const w = T.w, h = T.h, cx = (w - 1) / 2, cy = (h - 1) / 2;
    const A = 1 + P[2], B = P[3], tx = P[0], ty = P[1];
    const Te = T.e, Se = S.e, gxA = S.gx, gyA = S.gy;
    let n = 0, sT = 0, sI = 0, sTT = 0, sII = 0, sTI = 0;
    for (let y = 0; y < h; y++) {
      const ry = y - cy;
      for (let x = 0; x < w; x++) {
        const rx = x - cx;
        const sx = cx + A * rx - B * ry + tx, sy = cy + B * rx + A * ry + ty;
        if (sx < 1 || sy < 1 || sx > w - 2 || sy > h - 2) continue;
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, i = y0 * w + x0;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const v = Se[i] * w00 + Se[i + 1] * w10 + Se[i + w] * w01 + Se[i + w + 1] * w11;
        const t = Te[y * w + x];
        sT += t; sI += v; sTT += t * t; sII += v * v; sTI += t * v;
        if (b) {
          b.t[n] = t; b.v[n] = v; b.rx[n] = rx; b.ry[n] = ry;
          b.gx[n] = gxA[i] * w00 + gxA[i + 1] * w10 + gxA[i + w] * w01 + gxA[i + w + 1] * w11;
          b.gy[n] = gyA[i] * w00 + gyA[i + 1] * w10 + gyA[i + w] * w01 + gyA[i + w + 1] * w11;
        }
        n++;
      }
    }
    const r = { n, cover: n / (w * h), z: -1, mT: 0, mI: 0, sT: 1, sI: 1 };
    if (b) b.n = n;
    if (n < w * h * MIN_COVER * 0.5) return r;
    r.mT = sT / n; r.mI = sI / n;
    const vT = sTT / n - r.mT * r.mT, vI = sII / n - r.mI * r.mI;
    r.sT = Math.sqrt(Math.max(vT, 1e-12)); r.sI = Math.sqrt(Math.max(vI, 1e-12));
    r.z = (sTI / n - r.mT * r.mI) / (r.sT * r.sI);
    if (vT < 1e-10 || vI < 1e-10) r.z = -1;
    return r;
  }

  function solve4(H, g) {      // 4元連立方程式（ガウスの消去法）
    const m = [0, 1, 2, 3].map(i => [...H[i], g[i]]);
    for (let c = 0; c < 4; c++) {
      let p = c;
      for (let r = c + 1; r < 4; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      if (Math.abs(m[p][c]) < 1e-12) return null;
      [m[c], m[p]] = [m[p], m[c]];
      for (let r = c + 1; r < 4; r++) { const f = m[r][c] / m[c][c]; for (let k = c; k < 5; k++) m[r][k] -= f * m[c][k]; }
    }
    const x = [0, 0, 0, 0];
    for (let r = 3; r >= 0; r--) { let s = m[r][4]; for (let k = r + 1; k < 4; k++) s -= m[r][k] * x[k]; x[r] = s / m[r][r]; }
    return x;
  }

  /** ガウス・ニュートン法（LM法）で、位置合わせの良さを少しずつ上げる */
  function refine(T, S, P0, iters) {
    const n0 = T.w * T.h;
    let bufA = buf(n0, 'a'), bufB = buf(n0, 'b');
    let P = P0.slice(), cur = stats(T, S, P, bufA), lam = 0.01;
    if (cur.z <= -1) return { P, z: cur.z, cover: cur.cover };
    for (let it = 0; it < iters; it++) {
      const n = bufA.n, mJ = [0, 0, 0, 0], inv = 1 / cur.sI;
      for (let k = 0; k < n; k++) {
        const gx = bufA.gx[k], gy = bufA.gy[k];
        mJ[0] += gx; mJ[1] += gy; mJ[2] += gx * bufA.rx[k] + gy * bufA.ry[k]; mJ[3] += -gx * bufA.ry[k] + gy * bufA.rx[k];
      }
      for (let j = 0; j < 4; j++) mJ[j] /= n;
      const H = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], g = [0, 0, 0, 0], J = [0, 0, 0, 0];
      for (let k = 0; k < n; k++) {
        const gx = bufA.gx[k], gy = bufA.gy[k], rx = bufA.rx[k], ry = bufA.ry[k];
        J[0] = (gx - mJ[0]) * inv; J[1] = (gy - mJ[1]) * inv;
        J[2] = (gx * rx + gy * ry - mJ[2]) * inv; J[3] = (-gx * ry + gy * rx - mJ[3]) * inv;
        const e = (bufA.t[k] - cur.mT) / cur.sT - (bufA.v[k] - cur.mI) * inv;
        for (let i = 0; i < 4; i++) { g[i] += J[i] * e; for (let j = i; j < 4; j++) H[i][j] += J[i] * J[j]; }
      }
      for (let i = 0; i < 4; i++) for (let j = 0; j < i; j++) H[i][j] = H[j][i];
      let accepted = false;
      for (let tries = 0; tries < 6 && !accepted; tries++) {
        const Hl = H.map((row, i) => row.map((v, j) => i === j ? v * (1 + lam) + 1e-9 : v));
        const d = solve4(Hl, g);
        if (!d) { lam *= 10; continue; }
        const Pn = [P[0] + d[0], P[1] + d[1], P[2] + d[2], P[3] + d[3]];
        const nxt = stats(T, S, Pn, bufB);
        if (nxt.z > cur.z) {
          const small = Math.abs(d[0]) < 0.02 && Math.abs(d[1]) < 0.02 && Math.abs(d[2]) < 2e-5 && Math.abs(d[3]) < 2e-5;
          P = Pn; cur = nxt; [bufA, bufB] = [bufB, bufA]; lam = Math.max(lam / 3, 1e-4); accepted = true;
          if (small) it = iters;
        } else lam *= 8;
      }
      if (!accepted) break;
    }
    return { P, z: cur.z, cover: cur.cover };
  }

  const toLevel = (P, l) => [P[0] / (1 << l), P[1] / (1 << l), P[2], P[3]];
  const fromLevel = (P, l) => [P[0] * (1 << l), P[1] * (1 << l), P[2], P[3]];

  /** 現品(shot)をマスター(master)に位置合わせする。prepare() の結果を渡す
   *  戻り値: { P, score(0〜1), cover } P はマスター座標(384px換算)→現品座標の変換 */
  function align(master, shot) {
    const Tc = master.levels[COARSE], Sc = shot.levels[COARSE];
    // ① 小さい画像で、倍率・回転・位置を総当たりして候補を探す
    const cands = [], R = Math.round(Tc.w * 0.3);
    for (const s of [0.85, 0.925, 1, 1.075, 1.15]) for (const deg of [-20, -10, 0, 10, 20]) {
      const th = deg * Math.PI / 180, a = s * Math.cos(th) - 1, b = s * Math.sin(th);
      for (let ty = -R; ty <= R; ty += 2) for (let tx = -R; tx <= R; tx += 2) {
        const r = stats(Tc, Sc, [tx, ty, a, b], null);
        if (r.z > 0.05 && r.cover >= MIN_COVER) cands.push({ P: [tx, ty, a, b], z: r.z });
      }
    }
    cands.sort((p, q) => q.z - p.z);
    const picked = [];
    for (const c of cands) {
      if (picked.length >= 4) break;
      if (picked.every(p => Math.abs(p.P[0] - c.P[0]) > 4 || Math.abs(p.P[1] - c.P[1]) > 4 || Math.abs(p.P[2] - c.P[2]) > 0.08 || Math.abs(p.P[3] - c.P[3]) > 0.1)) picked.push(c);
    }
    if (!picked.length) return { P: [0, 0, 0, 0], score: 0, cover: 0 };
    // ② 候補を粗い段で磨いて、いちばん良いものを選ぶ
    let best = null;
    for (const c of picked) {
      let P = c.P, r = null;
      for (let l = COARSE; l >= LEVELS - 3; l--) {            // 48 → 96
        r = refine(master.levels[l], shot.levels[l], P, 14);
        P = r.P;
        if (l > LEVELS - 3) P = [P[0] * 2, P[1] * 2, P[2], P[3]];
      }
      if (!best || r.z > best.z) best = { P: fromLevel(P, LEVELS - 3), z: r.z };
    }
    // ③ 細かい段（192 → 384）で仕上げる
    let P = toLevel(best.P, 1);
    for (let l = 1; l >= 0; l--) {
      const r = refine(master.levels[l], shot.levels[l], P, l === 1 ? 10 : 6);
      P = r.P;
      if (l > 0) P = [P[0] * 2, P[1] * 2, P[2], P[3]];
    }
    P = fromLevel(P, 0);
    const fin = stats(master.levels[1], shot.levels[1], toLevel(P, 1), null);   // 192px の段で良さを測る
    return { P, score: Math.max(0, fin.z), cover: fin.cover };
  }

  /* ---------- ポイントごとの形状比較 ---------- */
  /** 現品の白黒画像を、変換 P でマスターと同じ位置・大きさに変形する */
  function warpGray(gray, P) {
    const w = gray.w, h = gray.h, cx = (w - 1) / 2, cy = (h - 1) / 2, A = 1 + P[2], B = P[3];
    const out = new Float32Array(w * h), valid = new Uint8Array(w * h);
    let sum = 0, cnt = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const rx = x - cx, ry = y - cy;
      const sx = cx + A * rx - B * ry + P[0], sy = cy + B * rx + A * ry + P[1];
      if (sx < 0 || sy < 0 || sx > w - 1.001 || sy > h - 1.001) continue;
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, i = y0 * w + x0, d = gray.d;
      const v = d[i] * (1 - fx) * (1 - fy) + d[i + 1] * fx * (1 - fy) + d[i + w] * (1 - fx) * fy + d[i + w + 1] * fx * fy;
      out[y * w + x] = v; valid[y * w + x] = 1; sum += v; cnt++;
    }
    const mean = cnt ? sum / cnt : 128;
    for (let i = 0; i < out.length; i++) if (!valid[i]) out[i] = mean;     // 範囲外は平均色で埋める（偽の輪郭を作らない）
    return { d: out, valid, w, h };
  }
  function compareEdges(gray, valid) {
    const w = gray.w, h = gray.h, e = blur3(sobel(blur3(gray.d, w, h), w, h), w, h);
    if (valid) for (let i = 0; i < e.length; i++) if (!valid[i]) e[i] = 0;
    return { e: normEdge(e, valid), w, h };
  }

  /** 四角（画素）の中の輪郭を比べる。わずかなずれ(±SHIFT px)は許して、最もよく合うところの一致度を返す(0〜100) */
  function compareRect(M, S, rc) {
    const w = M.w, h = M.h, a = M.e, b = S.e;
    const x0 = rc.x0, y0 = rc.y0, x1 = rc.x1, y1 = rc.y1, n = (x1 - x0) * (y1 - y0);
    let sA = 0, sAA = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = a[y * w + x]; sA += v; sAA += v * v; }
    const mA = sA / n, vA = sAA / n - mA * mA;
    let best = -1;
    for (let dy = -SHIFT; dy <= SHIFT; dy++) for (let dx = -SHIFT; dx <= SHIFT; dx++) {
      let sB = 0, sBB = 0, sAB = 0;
      for (let y = y0; y < y1; y++) {
        const yy = y + dy, inY = yy >= 0 && yy < h;
        for (let x = x0; x < x1; x++) {
          const xx = x + dx, v = (inY && xx >= 0 && xx < w) ? b[yy * w + xx] : 0, u = a[y * w + x];
          sB += v; sBB += v * v; sAB += u * v;
        }
      }
      const mB = sB / n, vB = sBB / n - mB * mB, cov = sAB / n - mA * mB;
      const z = (cov + EPS) / Math.sqrt((vA + EPS) * (vB + EPS));
      if (z > best) best = z;
    }
    return Math.max(0, Math.min(1, best)) * 100;
  }

  /** 位置合わせ(P)のあと、全ポイントの一致度を計算する。
   *  points: [{ x, y, w, h }]（0〜1 の比率）。戻り値: [{ score(0〜100), cover(0〜1) }] */
  function checkPoints(master, shot, P, points) {
    if (!master.cmp) master.cmp = compareEdges(master.gray, null);
    const wp = warpGray(shot.gray, P), S = compareEdges({ d: wp.d, w: wp.w, h: wp.h }, wp.valid);
    const W = master.gray.w, H = master.gray.h;
    return points.map(p => {
      const rc = {
        x0: Math.max(0, Math.min(W - 4, Math.round(p.x * W))), y0: Math.max(0, Math.min(H - 4, Math.round(p.y * H))),
        x1: 0, y1: 0
      };
      rc.x1 = Math.max(rc.x0 + 4, Math.min(W, Math.round((p.x + p.w) * W)));
      rc.y1 = Math.max(rc.y0 + 4, Math.min(H, Math.round((p.y + p.h) * H)));
      let inside = 0;
      for (let y = rc.y0; y < rc.y1; y++) for (let x = rc.x0; x < rc.x1; x++) inside += wp.valid[y * W + x];
      const cover = inside / ((rc.x1 - rc.x0) * (rc.y1 - rc.y0));
      return { score: compareRect(master.cmp, S, rc), cover };
    });
  }

  /** マスター座標(0〜1)の点 → 現品写真の座標(0〜1)。結果画面の枠を重ねるのに使う */
  function mapPoint(P, nx, ny) {
    const W = WORK, c = (W - 1) / 2, rx = nx * W - c, ry = ny * W - c;
    return [(c + (1 + P[2]) * rx - P[3] * ry + P[0]) / W, (c + P[3] * rx + (1 + P[2]) * ry + P[1]) / W];
  }

  const api = { WORK, MIN_COVER, prepare, align, checkPoints, mapPoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Shape = api;
})(typeof self !== 'undefined' ? self : this);
