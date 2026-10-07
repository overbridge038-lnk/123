'use strict';
/* 照合キー方式の画面部分（管理者のキー設定・サンプルの区分・精度の確認、全員の結果レポート・撮影のヘルプ）。
 * app.js の道具（$ / openDialog / cloud / master など）は、呼ばれたときに使います（app.js より先に読み込まれます）。
 * 計算は keys.js（Keys）が担当します。 */
const KEY_TYPES = { shape: '形状', presence: '有無', engrave: '刻印' };
const KEY_COLORS = { shape: '#00e5ff', presence: '#ff4081', engrave: '#ffeb3b' };
const BAD_TYPES = ['欠品', '付け間違い', '別品番', 'その他'];
const STATE_LABEL = { ok: 'OK', ng: 'NG', unk: '判定不能' };
const newKeyId = () => 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const KeyUI = {
  /* ---------- 撮影のヘルプ ---------- */
  helpDialog() {
    return openDialog((d, close) => {
      d.innerHTML = `<h3>撮影のコツ（黒い塗装品）</h3>
        <ol class="help-list">
          <li><b>白い背景の上に置く：</b>白い紙かライトボックスの上に部品を置き、<b>真上から</b>撮ります（影絵として形を取ります）。外形・穴・切り欠きがはっきり写ります。</li>
          <li><b>照明は毎回同じに：</b>黒い艶のある面は、光の当たり方で見え方が変わります。<b>斜めからの拡散光</b>（光を直接当てず、白い板や紙で柔らかくした光）を、毎回同じ向き・強さで当ててください。刻印は、斜めからの光だと凹凸が見えやすくなります。</li>
          <li><b>撮影台を固定：</b>カメラ（タブレット）と台は動かないようにします。部品の置き位置を決める<b>治具や目印（台に印刷した基準マーク）</b>を使うことをおすすめします。</li>
          <li><b>枠の中に収める：</b>画面の点線の枠の中に部品全体を入れます。はみ出すと判定されません。</li>
          <li><b>1つだけ置く：</b>部品が複数写っていたり、背景に他のものがあったりすると判定されません。</li>
          <li><b>判定されないとき：</b>ピンぼけ・暗い／明るすぎ・背景のむら・部品なし・枠からのはみ出し・複数の部品・位置合わせの失敗のときは、<b>「判定不能」</b>（黄色）になります。理由を見て撮り直してください。OKにはなりません。</li>
        </ol>
        <div class="row"><button class="btn primary" id="hpClose">閉じる</button></div>`;
      $('#hpClose', d).onclick = () => close();
    });
  },

  /* ---------- サンプル写真の区分を選ぶ ---------- */
  /** init = { kind, type, memo }。戻り値: { kind:'good'|'bad', type?, memo? } または null（キャンセル）。title は見出し、withDelete は「削除」ボタンを出す */
  sampleMetaDialog(title, init, withDelete) {
    init = init || { kind: 'good' };
    return openDialog((d, close) => {
      let kind = ['master', 'good', 'bad'].includes(init.kind) ? init.kind : 'good', type = init.type || '欠品';
      d.innerHTML = `<h3>${esc(title)}</h3>
        <label class="field-label">この写真は？</label>
        <div class="seg" id="smKind"><button type="button" data-v="master">マスター</button><button type="button" data-v="good">正しい品</button><button type="button" data-v="bad">誤品</button></div>
        <div id="smBad">
          <label class="field-label" style="margin-top:12px">誤品の種類</label>
          <div class="seg" id="smType">${BAD_TYPES.map(t => `<button type="button" data-v="${t}">${t}</button>`).join('')}</div>
        </div>
        <label class="field-label" style="margin-top:12px" id="smMemoL">メモ（省略可）</label>
        <input class="input" id="smMemo" type="text" maxlength="100" placeholder="例：右のボルトが無い" value="${esc(init.memo || '')}">
        <div class="row">${withDelete ? '<button class="btn danger" id="smDel">削除</button>' : ''}<button class="btn" id="smCancel">キャンセル</button><button class="btn primary" id="smOk">OK</button></div>`;
      const sync = () => {
        $$('#smKind button', d).forEach(b => b.classList.toggle('on', b.dataset.v === kind));
        $$('#smType button', d).forEach(b => b.classList.toggle('on', b.dataset.v === type));
        $('#smBad', d).hidden = kind !== 'bad';
        $('#smMemo', d).hidden = $('#smMemoL', d).hidden = kind === 'master';
      };
      $$('#smKind button', d).forEach(b => b.onclick = () => { kind = b.dataset.v; sync(); });
      $$('#smType button', d).forEach(b => b.onclick = () => { type = b.dataset.v; sync(); });
      sync();
      $('#smCancel', d).onclick = () => close(null);
      $('#smOk', d).onclick = () => close(Object.assign({ kind }, kind === 'bad' ? { type } : {}, kind === 'master' ? {} : { memo: $('#smMemo', d).value.trim() }));
      if (withDelete) $('#smDel', d).onclick = () => close({ del: true });
    });
  },

  /* ---------- 照合キーの設定画面（管理者のみ） ---------- */
  async editKeys(m) {
    const part = master.editing, partNo = part.partNo;
    let keys = cleanKeys(part.keySets && part.keySets[m.id]).map(k => Object.assign({}, k));
    let mp;
    try { mp = await masterKeyPrep(m); }
    catch (e) { console.error(e); await showErrorReport('マスター写真を読み込めませんでした', (e && e.message) || String(e), describeError(e, '照合キーの設定')); return; }
    const prep = mp.prep, an = mp.an;
    const otherKeys = Object.entries(part.keySets || {}).filter(([id]) => id !== m.id).reduce((a, [, v]) => a + (Array.isArray(v) ? v.length : 0), 0);
    const legacy = pointsOf(part, m.id);
    let sel = -1, dirty = false, drag = null, showMask = false, lastType = 'shape';
    const url = URL.createObjectURL(m.blob), img = new Image();
    // 影絵（アプリが部品とみなした範囲）を、写真に重ねて見られるようにする
    const maskCv = document.createElement('canvas'); maskCv.width = maskCv.height = prep.w;
    { const c = maskCv.getContext('2d'), id = c.createImageData(prep.w, prep.h);
      for (let i = 0; i < prep.mask.length; i++) if (prep.mask[i]) { id.data[4 * i] = 255; id.data[4 * i + 1] = 40; id.data[4 * i + 2] = 40; id.data[4 * i + 3] = 110; }
      c.putImageData(id, 0, 0); }
    await openDialog((d, close) => {
      d.classList.add('wide');
      d.innerHTML = `<h3>照合キー（${esc(partNo)}）</h3>
        <div id="keQual"></div>
        <div class="pe-wrap">
          <div class="pe-box"><canvas id="keCanvas"></canvas></div>
          <div class="pe-side">
            <div class="hint" id="keHint"></div>
            <div class="row wrap"><button class="btn small" id="keMask" type="button">影絵を表示</button>${legacy.length ? `<button class="btn small" id="keLegacy" type="button">旧・検査ポイント${legacy.length}個を取り込む</button>` : ''}</div>
            <div class="pe-list" id="keList"></div>
            <div class="pe-form" id="keForm" hidden>
              <label class="field-label">名前（例：左の穴、ブラケット、先端の曲げ）</label>
              <input class="input" id="keName" type="text" maxlength="30">
              <label class="field-label" style="margin-top:12px">種類</label>
              <div class="seg" id="keType">${Object.entries(KEY_TYPES).map(([k, v]) => `<button type="button" data-v="${k}">${v}</button>`).join('')}</div>
              <div class="hint" id="keTypeHelp"></div>
              <div id="keExpBox" style="margin-top:8px">
                <label class="field-label">期待値（マスター写真から自動で取り出しました）</label>
                <canvas class="ke-thumb" id="keThumb" width="120" height="120"></canvas>
                <div class="hint" id="keInfo"></div>
                <div class="ke-warn" id="keWarn" hidden></div>
                <div id="kePresBox"><label class="field-label">この場所に部品は？（マスターの状態）</label>
                  <div class="seg" id="kePres"><button type="button" data-v="1">ある</button><button type="button" data-v="0">ない</button></div></div>
              </div>
              <label class="field-label" style="margin-top:12px">許容差：合格ライン（一致度 %）</label>
              <div class="stepper">
                <button id="keThM5" class="btn step" type="button" style="font-size:22px">−5</button>
                <button id="keThM" class="btn step" type="button">−</button>
                <div id="keThV" class="step-val" style="font-size:32px;min-width:110px">80%</div>
                <button id="keThP" class="btn step" type="button">＋</button>
                <button id="keThP5" class="btn step" type="button" style="font-size:22px">＋5</button>
                <button id="keThR" class="btn" type="button">標準</button>
              </div>
              <div class="hint">一致度がこの値以上ならOK。大きくするほど厳しくなります。サンプル写真で「精度の確認」をして調整します。</div>
              <label class="field-label" style="margin-top:12px">重要度</label>
              <div class="seg" id="keMust"><button type="button" data-v="1">必須</button><button type="button" data-v="0">参考</button></div>
              <div class="hint">必須：NGなら全体もNG。参考：結果に表示するだけ。</div>
              <button id="keDel" class="btn danger" type="button" style="margin-top:8px">このキーを削除</button>
            </div>
          </div>
        </div>
        <div class="row"><button class="btn" id="keClose">閉じる</button><button class="btn primary" id="keSave">保存</button></div>`;
      const cv = $('#keCanvas', d), ctx = cv.getContext('2d'), th = $('#keThumb', d), tctx = th.getContext('2d');
      let size = 300;
      $('#keQual', d).innerHTML = an.ok
        ? `<div class="ke-ok">✔ このマスター写真の撮影チェックは問題ありません（背景 ${an.m.bg}・鋭さ ${an.m.sharp}）</div>`
        : `<div class="ke-warn">このマスター写真は撮影条件を満たしていません。白い背景に置いて真上から撮り直すことをおすすめします：<br>${an.issues.map(i => esc(i.msg)).join('<br>')}</div>`;
      const typeHelp = {
        shape: '指定した領域の形（外形の輪郭・穴・曲げ・切り欠き・先端）が、マスターと一致するかを見ます。縁や穴を含めて囲んでください。',
        presence: '指定した領域に、部品（ボルト・ナット・ブラケット・クリップなど）が「ある／ない」かを、マスターとの違いで見ます。',
        engrave: '刻印（凹凸の文字・記号・マーク）の形・コントラストのパターンを、マスターと比べます（文字の読み取りはしません）。見えないときは判定不能です。'
      };
      const draw = () => {
        const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
        size = r.width || size;
        if (cv.width !== Math.round(size * dpr)) cv.width = cv.height = Math.round(size * dpr);
        ctx.setTransform(cv.width / size, 0, 0, cv.width / size, 0, 0);
        ctx.clearRect(0, 0, size, size);
        if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, size, size);
        if (showMask) ctx.drawImage(maskCv, 0, 0, size, size);
        keys.forEach((p, i) => {
          const x = p.x * size, y = p.y * size, w = p.w * size, h = p.h * size, on = i === sel, col = KEY_COLORS[p.type];
          ctx.setLineDash(p.must ? [] : [8, 5]);
          ctx.lineWidth = on ? 4 : 3; ctx.strokeStyle = on ? '#ff9800' : col;
          ctx.fillStyle = on ? 'rgba(255,152,0,.22)' : 'rgba(255,255,255,.10)';
          ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
          ctx.font = 'bold 18px sans-serif'; ctx.lineWidth = 4; ctx.strokeStyle = '#000'; ctx.fillStyle = '#fff';
          ctx.strokeText(String(i + 1), x + 4, y + 20); ctx.fillText(String(i + 1), x + 4, y + 20);
          if (on) {
            ctx.fillStyle = '#ff9800'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
            for (const [cx, cy] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) { ctx.beginPath(); ctx.arc(cx, cy, 11, 0, 7); ctx.fill(); ctx.stroke(); }
          }
        });
      };
      /** 選んだキーの領域を、小さな画像で見せる（形状は影絵、ほかは写真） */
      const thumb = p => {
        tctx.clearRect(0, 0, 120, 120);
        if (!p || !img.naturalWidth || p.w < 0.01 || p.h < 0.01) return;
        const sw = p.w * img.naturalWidth, sh = p.h * img.naturalHeight, k = Math.min(120 / sw, 120 / sh), dw = sw * k, dh = sh * k;
        tctx.fillStyle = '#000'; tctx.fillRect(0, 0, 120, 120);
        if (p.type === 'shape') {
          const id = tctx.createImageData(Math.max(1, Math.round(dw)), Math.max(1, Math.round(dh)));
          for (let y = 0; y < id.height; y++) for (let x = 0; x < id.width; x++) {
            const mx = Math.min(prep.w - 1, Math.floor((p.x + p.w * x / id.width) * prep.w)), my = Math.min(prep.h - 1, Math.floor((p.y + p.h * y / id.height) * prep.h));
            const v = prep.mask[my * prep.w + mx] ? 40 : 245, o = 4 * (y * id.width + x);
            id.data[o] = id.data[o + 1] = id.data[o + 2] = v; id.data[o + 3] = 255;
          }
          tctx.putImageData(id, 0, 0);
        } else tctx.drawImage(img, p.x * img.naturalWidth, p.y * img.naturalHeight, sw, sh, 0, 0, dw, dh);
      };
      const info = p => { try { return Keys.describeRegion(prep, p); } catch (e) { console.warn(e); return null; } };
      const form = () => {
        const p = keys[sel];
        $('#keForm', d).hidden = !p;
        const total = keys.length + otherKeys;
        $('#keHint', d).textContent = (keys.length
          ? (total >= KEYS_PER_PART ? `この品番のキーが最大${KEYS_PER_PART}個に達しました。` : '空いている所を指でなぞると四角が増えます。') + '四角の中を動かすと移動、角の丸を動かすと大きさが変わります。'
          : '写真の上を指でなぞって、見分けたい場所を四角で囲んでください。') + `（この品番のキー ${total}/${KEYS_PER_PART}）`;
        const list = $('#keList', d); list.innerHTML = '';
        keys.forEach((q, i) => {
          const b = document.createElement('button'); b.type = 'button'; b.className = i === sel ? 'sel' : '';
          b.textContent = `${i + 1}. ${q.name}（${KEY_TYPES[q.type]}${q.must ? '' : '・参考'}）`;
          b.onclick = () => { sel = i; form(); draw(); };
          list.appendChild(b);
        });
        if (!p) return;
        $('#keName', d).value = p.name;
        $$('#keType button', d).forEach(b => b.classList.toggle('on', b.dataset.v === p.type));
        $('#keTypeHelp', d).textContent = typeHelp[p.type];
        const v = typeof p.th === 'number' ? p.th : Keys.DEFAULT_TH[p.type];
        $('#keThV', d).textContent = v + '%' + (typeof p.th === 'number' ? '' : '（標準）');
        $$('#keMust button', d).forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === p.must));
        $('#kePresBox', d).hidden = p.type !== 'presence';
        $$('#kePres button', d).forEach(b => b.classList.toggle('on', (b.dataset.v === '1') === !(p.exp && p.exp.present === false)));
        const inf = info(p);
        $('#keInfo', d).textContent = inf ? (p.type === 'shape' ? `領域の中の部品の割合 ${(inf.fg * 100).toFixed(0)}%・輪郭 ${inf.boundary}画素` : p.type === 'engrave' ? `刻印のコントラスト ${inf.contrast.toFixed(1)}（${inf.contrast >= Keys.ENG_MIN ? '見えています' : '見えません'}）` : `領域の中の部品の割合 ${(inf.fg * 100).toFixed(0)}%・輪郭の強さ ${inf.edge.toFixed(2)}`) : '（計算できませんでした）';
        const w = $('#keWarn', d); w.hidden = !(inf && inf.warn); w.textContent = inf ? inf.warn : '';
        thumb(p);
      };
      const refresh = () => { form(); draw(); };
      img.onload = refresh; img.src = url;
      new ResizeObserver(draw).observe(cv);

      $('#keMask', d).onclick = () => { showMask = !showMask; $('#keMask', d).textContent = showMask ? '影絵を隠す' : '影絵を表示'; draw(); };
      if (legacy.length) $('#keLegacy', d).onclick = async () => {
        const room = KEYS_PER_PART - otherKeys - keys.length;
        if (room <= 0) { toast(`キーは1つの品番に${KEYS_PER_PART}個までです`, 3000); return; }
        if (!await ask(`旧・検査ポイント${legacy.length}個を、形状キーとして追加します。合格ラインは標準に戻ります（一致度の計算方法が違うため、「精度の確認」で調整してください）。`, '取り込む')) return;
        legacy.slice(0, room).forEach(p => keys.push({ id: newKeyId(), name: p.name, type: 'shape', x: p.x, y: p.y, w: p.w, h: p.h, must: p.must !== false }));
        dirty = true; sel = -1; refresh();
      };
      $('#keName', d).oninput = e => { if (keys[sel]) { keys[sel].name = e.target.value.slice(0, 30); dirty = true; const b = $('#keList', d).children[sel]; if (b) b.textContent = `${sel + 1}. ${keys[sel].name}（${KEY_TYPES[keys[sel].type]}${keys[sel].must ? '' : '・参考'}）`; } };
      $$('#keType button', d).forEach(b => b.onclick = () => {
        const p = keys[sel]; if (!p) return;
        p.type = b.dataset.v; lastType = p.type; delete p.th;
        if (p.type === 'presence') { const inf = info(p); p.exp = { present: inf ? inf.present : true }; } else delete p.exp;
        dirty = true; refresh();
      });
      $$('#kePres button', d).forEach(b => b.onclick = () => { const p = keys[sel]; if (p && p.type === 'presence') { p.exp = { present: b.dataset.v === '1' }; dirty = true; refresh(); } });
      const stepTh = dv => { const p = keys[sel]; if (!p) return; p.th = Math.max(1, Math.min(99, (typeof p.th === 'number' ? p.th : Keys.DEFAULT_TH[p.type]) + dv)); dirty = true; refresh(); };
      $('#keThM', d).onclick = () => stepTh(-1); $('#keThP', d).onclick = () => stepTh(1);
      $('#keThM5', d).onclick = () => stepTh(-5); $('#keThP5', d).onclick = () => stepTh(5);
      $('#keThR', d).onclick = () => { if (keys[sel]) { delete keys[sel].th; dirty = true; refresh(); } };
      $$('#keMust button', d).forEach(b => b.onclick = () => { if (keys[sel]) { keys[sel].must = b.dataset.v === '1'; dirty = true; refresh(); } });
      $('#keDel', d).onclick = () => { if (sel < 0) return; keys.splice(sel, 1); sel = -1; dirty = true; refresh(); };

      /* ---- 指の操作：新しく描く／動かす／大きさを変える ---- */
      const norm = e => { const r = cv.getBoundingClientRect(); return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)]; };
      const HIT = 26;
      cv.onpointerdown = e => {
        e.preventDefault(); cv.setPointerCapture(e.pointerId);
        const [nx, ny] = norm(e), hr = HIT / size;
        if (sel >= 0) {
          const p = keys[sel], cs = [[p.x, p.y], [p.x + p.w, p.y], [p.x + p.w, p.y + p.h], [p.x, p.y + p.h]];
          const k = cs.findIndex(([cx, cy]) => Math.hypot(cx - nx, cy - ny) < hr);
          if (k >= 0) { const [ax, ay] = cs[(k + 2) % 4]; drag = { mode: 'resize', ax, ay }; return; }
        }
        let hit = -1;
        const inside = p => nx >= p.x && nx <= p.x + p.w && ny >= p.y && ny <= p.y + p.h;
        if (sel >= 0 && inside(keys[sel])) hit = sel;
        else keys.forEach((p, i) => { if (inside(p) && (hit < 0 || p.w * p.h < keys[hit].w * keys[hit].h)) hit = i; });
        if (hit >= 0) { sel = hit; drag = { mode: 'move', ox: nx - keys[hit].x, oy: ny - keys[hit].y }; refresh(); return; }
        if (keys.length + otherKeys >= KEYS_PER_PART) { toast(`キーは1つの品番に${KEYS_PER_PART}個までです`, 3000); sel = -1; refresh(); return; }
        keys.push({ id: newKeyId(), name: `${KEY_TYPES[lastType]}${keys.length + 1}`, type: lastType, x: nx, y: ny, w: 0, h: 0, must: true });
        sel = keys.length - 1; drag = { mode: 'new', ax: nx, ay: ny, fresh: true }; refresh();
      };
      cv.onpointermove = e => {
        if (!drag) return;
        const [nx, ny] = norm(e), p = keys[sel]; if (!p) return;
        if (drag.mode === 'move') { p.x = Math.max(0, Math.min(1 - p.w, nx - drag.ox)); p.y = Math.max(0, Math.min(1 - p.h, ny - drag.oy)); }
        else { p.x = Math.min(drag.ax, nx); p.y = Math.min(drag.ay, ny); p.w = Math.abs(nx - drag.ax); p.h = Math.abs(ny - drag.ay); }
        dirty = true; draw();
      };
      const end = () => {
        if (!drag) return;
        const p = keys[sel];
        if (p && drag.mode !== 'move' && (p.w < 0.03 || p.h < 0.03)) {
          if (drag.fresh) { keys.splice(sel, 1); sel = -1; } else { p.w = Math.max(p.w, 0.03); p.h = Math.max(p.h, 0.03); p.x = Math.min(p.x, 1 - p.w); p.y = Math.min(p.y, 1 - p.h); }
        } else if (p && drag.fresh && p.type === 'presence' && !p.exp) { const inf = info(p); p.exp = { present: inf ? inf.present : true }; }
        drag = null; refresh();
      };
      cv.onpointerup = cv.onpointercancel = end;

      const finish = v => { URL.revokeObjectURL(url); close(v); };
      $('#keClose', d).onclick = async () => { if (!dirty || await ask('保存していない変更があります。閉じてよいですか？', '閉じる', true)) finish(false); };
      $('#keSave', d).onclick = async () => {
        const btn = $('#keSave', d); btn.disabled = true; btn.textContent = '保存中…';
        try { await cloud.setKeys(partNo, m.id, cleanKeys(keys)); toast('照合キーを保存しました'); finish(true); }
        catch (e) { console.error(e); toast('保存に失敗：' + friendlyError(e), 6000); btn.disabled = false; btn.textContent = '保存'; }
      };
    });
    const cur = await dbGet('cparts', partNo); if (cur && master.editing) master.editing = cur;
    master.renderMasters();
  },

  /* ---------- 精度の確認（サンプル全部を、いまのキーで判定する） ---------- */
  async accuracy(partNo) {
    const part = await dbGet('cparts', partNo);
    const all = await mastersOf(partNo);
    const masters = all.filter(m => kindOf(part, m.id) === 'master' && keysOf(part, m.id).length).sort((a, b) => a.createdAt - b.createdAt);
    const samples = all.filter(m => kindOf(part, m.id) !== 'master').sort((a, b) => a.createdAt - b.createdAt);
    if (!masters.length) { await inform('照合キーが設定されていません。先にマスター写真の「◎ 照合キー」で設定してください。'); return; }
    if (!samples.length) { await inform('サンプル写真がありません。正しい品・誤品のサンプル写真を追加してください。'); return; }
    let cancelled = false;
    await openDialog(async (d, close) => {
      d.classList.add('wide');
      d.innerHTML = `<h3>精度の確認（${esc(partNo)}）</h3><div id="acBody"><div class="hint" id="acProg">準備中…</div></div><div class="row"><button class="btn primary" id="acClose">閉じる</button></div>`;
      $('#acClose', d).onclick = () => { cancelled = true; close(); };
      const rows = [];
      try {
        const list = await keyMasterList(part, masters);
        for (let i = 0; i < samples.length && !cancelled; i++) {
          const s = samples[i], meta = part.samples[s.id];
          $('#acProg', d).textContent = `判定中… ${i + 1}/${samples.length}枚`;
          await sleep(20);
          const r = Keys.evaluate(list, grayFromCanvas(await canvasFromFile(s.blob, MASTER_SIZE), Keys.WORK));
          rows.push({ n: i + 1, kind: meta.kind, type: meta.type || '', memo: meta.memo || '', r });
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) fillErrorBox($('#acBody', d), '精度の確認でエラー', (e && e.message) || String(e), describeError(e, '精度の確認'));
        return;
      }
      if (cancelled) return;
      const good = rows.filter(r => r.kind === 'good'), bad = rows.filter(r => r.kind === 'bad');
      const goodOk = good.filter(r => r.r.result === 'OK').length, badOk = bad.filter(r => r.r.result === 'OK').length;
      const unkN = rows.filter(r => r.r.result === 'UNK').length;
      const pass = good.length > 0 && bad.length > 0 && badOk === 0;
      // キーごとの測定値：正しい品の最小・誤品の最大
      const stat = {};
      for (const r of rows) for (const it of r.r.items || []) {
        if (it.why) continue;
        const s = stat[it.id] = stat[it.id] || { name: it.name, type: it.type, th: it.th, g: [], b: [] };
        (r.kind === 'good' ? s.g : s.b).push(it.score);
      }
      const f = a => a.length ? a.reduce((x, y) => Math.min(x, y)).toFixed(0) : '—';
      $('#acBody', d).innerHTML = `
        <div class="acc-sum ${badOk === 0 && bad.length ? 'good' : 'bad'}">誤品をOKにした件数：${badOk}件 ${bad.length ? (badOk === 0 ? '（合格）' : '（不合格）') : '（誤品サンプルなし）'}</div>
        <div class="acc-sum">正しい品のOK率：${good.length ? Math.round(goodOk / good.length * 100) : 0}%（${goodOk}/${good.length}枚）</div>
        <div class="hint">判定不能：${unkN}枚（撮影不良・位置合わせ失敗・境界値など。OKにはなりません）。${good.length ? '' : '正しい品のサンプルがありません。'}${bad.length ? '' : '誤品のサンプルがないので、誤品を見分けられるか確かめられていません。'}</div>
        <div class="acc-sum ${pass ? 'good' : 'bad'}">総合：${pass ? '合格' : '不合格または確認不足'}</div>
        <h4>キーごとの測定値（一致度 %）</h4>
        <table class="acc"><tr><th>キー</th><th>合格ライン</th><th>正しい品<br>最小</th><th>誤品<br>最小</th></tr>
        ${Object.values(stat).map(s => `<tr><td>${esc(s.name)}（${KEY_TYPES[s.type]}）</td><td>${s.th}</td><td>${f(s.g)}</td><td>${f(s.b)}</td></tr>`).join('')}</table>
        <div class="hint">「正しい品の最小」が合格ライン以上なら、正しい品を通せています。「誤品の最小」が合格ライン未満なら、そのキーは少なくとも1つの誤品を見分けられています（誤品は、違いのあるキーでだけ低くなります）。</div>
        <h4>サンプルごとの結果</h4>
        <ul class="acc-list" style="list-style:none;padding:0">${rows.map(r => {
          const tag = r.kind === 'good' ? '正しい品' : '誤品（' + esc(r.type) + '）';
          const bad1 = r.kind === 'bad' && r.r.result === 'OK', miss = r.kind === 'good' && r.r.result !== 'OK';
          const why = r.r.result === 'OK' ? '' : '：' + esc(r.r.reason);
          return `<li style="padding:3px 0;border-bottom:1px solid #d3d9e2;${bad1 ? 'color:#d32f2f;font-weight:800' : ''}">${r.n}. ${tag}${r.memo ? '「' + esc(r.memo) + '」' : ''} → <b>${r.r.result === 'UNK' ? UNK : r.r.result}</b>${bad1 ? ' ← 誤品がOKになりました！' : miss ? '' : ''}${why}</li>`;
        }).join('')}</ul>`;
    });
  },

  /* ---------- 結果レポート（照合画面の下） ---------- */
  /** out: verify.judgeKeys の結果。【照合結果】【判定理由】【検出された情報】【次のアクション提案】の文章を作る */
  buildReport(out) {
    const res = out.result === UNK ? '判定不能' : out.result;
    const items = out.items || [];
    const lines = items.map(it => this.itemLine(it));
    const detected = lines.map(l => l.text);
    if (out.align != null) detected.push(`位置合わせの信頼度：${out.align.toFixed(0)}%（基準 ${Keys.ALIGN_MIN * 100}%以上）`);
    if (out.quality) {
      const q = out.quality;
      detected.push(`撮影の品質：背景の明るさ ${q.bg}／部品との明るさの差 ${q.contrast}／輪郭の鋭さ ${q.sharp}（基準 ${Keys.SHARP_MIN}以上）／背景のばらつき ${q.bgStd}` + (out.issues && out.issues.length ? '／警告：' + out.issues.map(i => i.msg).join(' / ') : '／問題なし'));
    }
    const act = [];
    const codes = new Set((out.issues || []).map(i => i.code));
    if (out.result === 'OK') act.push('次の品物を照合してください。');
    else if (out.result === 'NG') {
      act.push('NGのキー（' + items.filter(i => i.must && i.state === 'ng').map(i => i.name).join('、') + '）の部分を、現物で確認してください（欠品・付け間違い・別品番の可能性があります）。');
      act.push('置き方や撮影の問題かもしれないので、1回だけ撮影台に置き直して再撮影してください。それでもNGなら誤品として扱い、手動で現物を確認してください。');
    } else {
      if (codes.has('blur')) act.push('ピントを合わせ、カメラ・台を動かさずに再撮影してください。');
      if (codes.has('dark') || codes.has('bright') || codes.has('contrast')) act.push('照明を確認して（明るさを一定に、黒い部品が白い背景ではっきり見えるように）再撮影してください。');
      if (codes.has('bgnoise')) act.push('背景を無地の白い紙・ライトボックスにして再撮影してください。');
      if (codes.has('frame')) act.push('部品全体を点線のガイド枠の中に収めて再撮影してください。');
      if (codes.has('none')) act.push('白い背景の上に部品を置いて再撮影してください。');
      if (codes.has('multi')) act.push('撮影台には部品を1つだけ置いて再撮影してください。');
      if (!out.issues || !out.issues.length) {
        if (out.align != null && out.align < Keys.ALIGN_MIN * 100) act.push('撮影台に置き直して再撮影してください（治具・目印に合わせて置くと安定します）。');
        if (items.some(i => i.state === 'unk' && i.type === 'engrave')) act.push('刻印が見えにくい場合は、斜めからの拡散光を、毎回同じ向きで当ててください。');
        if (items.some(i => i.state === 'unk')) act.push('置き直して再撮影してください。');
      }
      act.push('再撮影しても判定不能のときは、手動で現物を確認してください。');
    }
    if (!act.length) act.push('撮り直してください。判定できないときは手動で現物を確認してください。');
    const text = [`【照合結果】${res}`, `【判定理由】${out.reason || '—'}`, '【検出された情報】', ...detected.map(x => '・' + x), '【次のアクション提案】', ...act.map(x => '・' + x)].join('\n');
    return { res, lines, detected, act, text };
  },
  itemLine(it) {
    const st = STATE_LABEL[it.state] || it.state, ty = KEY_TYPES[it.type] || it.type, ref = it.must ? '' : '（参考）';
    let t;
    if (it.type === 'presence' && !it.why) t = `${it.name}${ref}：マスター ${it.exp}／現品 ${it.obs} → ${st}（信頼度 ${it.score}%・合格 ${it.th}%）`;
    else if (it.why) t = `${it.name}${ref}（${ty}）：${it.why} → ${st}`;
    else t = `${it.name}${ref}（${ty}）：期待どおりか ${it.score}%（合格 ${it.th}%）${it.detail ? '・' + it.detail : ''} → ${st}`;
    return { text: t, state: it.state, ref: !it.must };
  },
  /** 照合画面の下に、キーごとの一覧とレポートを出す */
  renderReport(box, out) {
    if (!out || out.mode !== 'keys') { box.hidden = true; box.innerHTML = ''; return; }
    const r = this.buildReport(out);
    box.hidden = false;
    box.innerHTML = `<div class="tapinfo" id="tapInfo" hidden></div>
      <h4>キーごとの結果</h4>
      <ul>${r.lines.map(l => `<li class="${l.ref ? 'ref' : ''}"><span class="st ${l.state}">${STATE_LABEL[l.state]}</span>${esc(l.text)}</li>`).join('') || '<li>（キーなし）</li>'}</ul>
      <h4>【照合結果】</h4><pre>${esc(r.res)}</pre>
      <h4>【判定理由】</h4><pre>${esc(out.reason || '—')}</pre>
      <h4>【検出された情報】</h4><pre>${esc(r.detected.map(x => '・' + x).join('\n'))}</pre>
      <h4>【次のアクション提案】</h4><pre>${esc(r.act.map(x => '・' + x).join('\n'))}</pre>`;
  },
  tapInfo(it) {
    const e = $('#tapInfo'); if (!e) return;
    if (!it) { e.hidden = true; return; }
    e.hidden = false; e.textContent = this.itemLine(it).text;
  }
};
