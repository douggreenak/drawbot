/* Drawbot Labels — UI glue. */
(function () {
  const $ = id => document.getElementById(id);
  const { layout } = window.DBLayout;
  const GC = window.DBGcode;
  const printer = new window.DBPrinter();

  // ---------------------------------------------------------------- state
  const SAVE_KEY = 'drawbot.settings.v1';
  const NUM_IDS = ['cellW', 'cellH', 'textH', 'pad', 'rowLen', 'rowGap', 'zUp', 'zDown', 'zFeed', 'svUp', 'svDown', 'svDelay',
                   'drawFeed', 'travelFeed', 'ox', 'oy', 'bedW', 'bedH', 'zx', 'zy'];
  const CHECK_IDS = ['borders', 'shrink', 'showTravel'];
  const SEGS = { rotSeg: '90', modeSeg: 'z', stepSeg: '10', anchorSeg: 'bl' };
  const state = { design: null, gc: null, job: null, homed: false, zSet: false, doneStrokes: 0 };

  const num = (id, d) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : d; };
  const segVal = id => $(id).querySelector('.on').dataset.v;

  function settings() {
    const bedW = num('bedW', 220), bedH = num('bedH', 220);
    return {
      penMode: segVal('modeSeg'),
      zUp: num('zUp', 3), zDown: num('zDown', 0), zFeed: Math.max(60, num('zFeed', 900)),
      svUp: num('svUp', 90), svDown: num('svDown', 40), svDelay: num('svDelay', 200),
      drawFeed: Math.max(60, num('drawFeed', 1800)), travelFeed: Math.max(60, num('travelFeed', 6000)),
      // card offset from the zero point; the chosen card corner sits at (ox, oy) from zero
      ox: num('ox', 20) - (/r/.test(segVal('anchorSeg')) && state.design ? state.design.width : 0),
      oy: num('oy', 20) - (/t/.test(segVal('anchorSeg')) && state.design ? state.design.height : 0),
      bedW, bedH, parkX: 0, parkY: 0,
    };
  }
  function layoutOpts() {
    return {
      cellW: Math.max(1, num('cellW', 6)), cellH: Math.max(2, num('cellH', 12)), textH: Math.max(0.5, num('textH', 3.5)),
      pad: Math.max(0, num('pad', 0.8)), rowLen: Math.max(5, num('rowLen', 180)), rowGap: Math.max(0, num('rowGap', 4)),
      rot: parseInt(segVal('rotSeg'), 10), lineGap: 0.5, borders: $('borders').checked, shrink: $('shrink').checked,
    };
  }

  function save() {
    const o = { labels: $('labels').value, seg: {} };
    NUM_IDS.concat(['genPrefix', 'genStart', 'genCount', 'genSuffix', 'baud', 'cardType']).forEach(i => (o[i] = $(i).value));
    CHECK_IDS.forEach(i => (o[i] = $(i).checked));
    Object.keys(SEGS).forEach(i => (o.seg[i] = segVal(i)));
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(o)); } catch (e) { /* private mode */ }
  }
  function load() {
    $('labels').value = '1\n2\n3\n4\n5\n6\n7\n8\nL+\nL-\nPE@8';
    let o; try { o = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { o = null; }
    if (!o) return;
    if (typeof o.labels === 'string') $('labels').value = o.labels;
    NUM_IDS.concat(['genPrefix', 'genStart', 'genCount', 'genSuffix', 'baud', 'cardType']).forEach(i => { if (o[i] !== undefined) $(i).value = o[i]; });
    CHECK_IDS.forEach(i => { if (o[i] !== undefined) $(i).checked = o[i]; });
    Object.entries(o.seg || {}).forEach(([id, v]) => setSeg(id, v));
  }

  // ---------------------------------------------------------------- UI bits
  function setSeg(id, v) {
    $(id).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === String(v)));
    $(id).querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', b.classList.contains('on')));
  }
  Object.keys(SEGS).forEach(id => $(id).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setSeg(id, b.dataset.v);
    if (id === 'modeSeg') syncMode();
    if (id === 'rotSeg') relayout(); else regen();   // anchorSeg / stepSeg / modeSeg
    save();
  }));
  function syncMode() {
    const z = segVal('modeSeg') === 'z';
    document.querySelector('.mode-z').hidden = !z;
    document.querySelector('.mode-servo').hidden = z;
  }

  let snackT;
  function toast(msg, ms = 3800) {
    const s = $('snack'); s.textContent = msg; s.classList.add('show');
    clearTimeout(snackT); snackT = setTimeout(() => s.classList.remove('show'), ms);
  }
  function confirmDlg(title, body, yes) {
    return new Promise(res => {
      $('dlgTitle').textContent = title; $('dlgBody').textContent = body; $('dlgYes').textContent = yes || 'Continue';
      const d = $('dlg');
      const done = v => { d.close(); $('dlgYes').onclick = $('dlgNo').onclick = null; res(v); };
      $('dlgYes').onclick = () => done(true); $('dlgNo').onclick = () => done(false);
      d.addEventListener('cancel', () => res(false), { once: true });
      d.showModal();
    });
  }
  function log(type, text) {
    const pre = $('log'), d = document.createElement('div');
    d.className = type; d.textContent = (type === 'tx' ? '> ' : type === 'sys' ? '• ' : '') + text;
    pre.appendChild(d);
    while (pre.childNodes.length > 400) pre.removeChild(pre.firstChild);
    pre.scrollTop = pre.scrollHeight;
  }
  const fmtTime = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}:${String(m).padStart(2, '0')}h` : `${m}:${String(s % 60).padStart(2, '0')}`; };

  // Expressive "cookie" shape for the logo
  (function blob(lobes = 9, depth = 0.04) {
    const pts = [];
    for (let i = 0; i <= 120; i++) {
      const a = (i / 120) * Math.PI * 2, r = 46 * (1 + depth * Math.cos(lobes * a));
      pts.push((i ? 'L' : 'M') + (r * Math.cos(a)).toFixed(2) + ' ' + (r * Math.sin(a)).toFixed(2));
    }
    $('blobPath').setAttribute('d', pts.join('') + 'Z');
  })();

  // ---------------------------------------------------------------- design pipeline
  function relayout() {
    state.design = layout($('labels').value, layoutOpts());
    regen();
  }
  function regen() {
    const s = settings(), d = state.design;
    state.gc = GC.build(d.strokes, s);
    const st = GC.stats(d.strokes, s);
    $('stLabels').textContent = d.count;
    $('stSize').textContent = `${d.width.toFixed(0)} × ${d.height.toFixed(0)}`;
    $('stStrokes').textContent = st.strokes;
    $('stTime').textContent = fmtTime(st.seconds);
    const bad = s.ox + d.width > s.bedW + 0.01 || s.oy + d.height > s.bedH + 0.01 || s.ox < 0 || s.oy < 0;
    $('stSize').parentElement.classList.toggle('bad', bad);
    state.outOfBed = bad;
    runPathCheck();
    if (state.pv) { cancelAnimationFrame(pvRaf); pvRaf = 0; state.pv = null; $('btnPreview').querySelector('span').textContent = 'Preview moves'; }
    draw(); drawBlocks();
  }

  // ---------------------------------------------------------------- toolpath check
  function runPathCheck() {
    const s = settings(), d = state.design;
    const sh = cardShape(d, num('rowGap', 4));
    const card = sh ? { x: s.ox + sh.frame.x, y: s.oy + sh.frame.y, w: sh.frame.w, h: sh.frame.h } : null;
    const p = state.path = window.DBPath.simulate(state.gc.lines, { ...s, zx: num('zx', 0), zy: num('zy', 0) }, card);
    const ul = $('pathIssues');
    ul.innerHTML = '';
    p.issues.forEach(i => { const li = document.createElement('li'); li.className = i.level; li.textContent = (i.level === 'error' ? '✗ ' : '! ') + i.text + (i.count > 1 ? ` (${i.count} moves)` : '') + (i.at ? ` — first at X${i.at[0].toFixed(1)} Y${i.at[1].toFixed(1)}` : ''); ul.appendChild(li); });
    if (!p.issues.length) { const li = document.createElement('li'); li.className = 'ok'; li.textContent = `✓ All ${p.moves} moves stay on the bed, above the paper and on the card.`; ul.appendChild(li); }
    const b = p.bbox, zxm = num('zx', 0), zym = num('zy', 0);
    $('pathStats').innerHTML = `<span>Travel area <b>X ${(b.minX + zxm).toFixed(0)}–${(b.maxX + zxm).toFixed(0)}, Y ${(b.minY + zym).toFixed(0)}–${(b.maxY + zym).toFixed(0)}</b> (bed coords)</span><span>Z range <b>${p.zmin.toFixed(1)} … ${p.zmax.toFixed(1)} mm</b></span><span>Ink <b>${p.drawLen.toFixed(0)} mm</b></span><span>Pen-up travel <b>${p.travelLen.toFixed(0)} mm</b></span>`;
    const chip = $('pathChip'); chip.className = 'chip ' + (p.errors ? 'err' : p.issues.length ? 'warn' : 'ok');
    $('pathChipText').textContent = p.errors ? `${p.errors} problem${p.errors > 1 ? 's' : ''}` : p.issues.length ? 'Warnings' : 'Path is safe';
    drawProfile();
  }
  function drawProfile() {
    const cv2 = $('zProfile'), c2 = cv2.getContext('2d'), p = state.path; if (!p) return;
    const dpr = window.devicePixelRatio || 1, W = cv2.clientWidth, H = 70; if (!W) return;
    cv2.width = W * dpr; cv2.height = H * dpr; c2.setTransform(dpr, 0, 0, dpr, 0, 0); c2.clearRect(0, 0, W, H);
    const zlo = Math.min(-1, p.zmin), zhi = Math.max(1, p.zmax), Y = z => H - 8 - (z - zlo) / (zhi - zlo) * (H - 16);
    c2.strokeStyle = css('--outline'); c2.lineWidth = 1; c2.setLineDash([4, 3]); c2.beginPath(); c2.moveTo(0, Y(0)); c2.lineTo(W, Y(0)); c2.stroke(); c2.setLineDash([]);
    c2.fillStyle = css('--on-surface-variant'); c2.font = '500 10px Roboto Flex, sans-serif'; c2.fillText('paper (Z 0)', 4, Y(0) - 3);
    const n = p.segs.length; if (!n) return;
    c2.beginPath(); p.segs.forEach((sg, i) => { const px = (i / n) * W; i ? c2.lineTo(px, Y(sg.z0)) : c2.moveTo(px, Y(sg.z0)); c2.lineTo(((i + 1) / n) * W, Y(sg.z1)); });
    c2.strokeStyle = css('--primary'); c2.lineWidth = 1.5; c2.stroke();
    p.segs.forEach((sg, i) => { if (sg.bad) { c2.fillStyle = css('--error'); c2.fillRect((i / n) * W, H - 4, Math.max(1, W / n), 4); } });
  }

  // ---------------------------------------------------------------- card geometry
  // Measured from the physical marker cards (see README): white ladder frame, each strip hangs from the
  // crossbar above it, a slot below it, and a rail down each side.  All values in mm.
  const CARD = { rail: 5.5, slot: 4, clear: 0.3 };
  // Marker variants. w = pitch (mm), h = marker height (mm); `src` = where the numbers come from.
  // Frame (rail/slot/gap) is only measured for the Weidmüller DEK 5 FW cards in the photos; the others reuse it.
  const WEID = 'Weidmüller datasheet (eshop.weidmueller.com)', PHX = 'Phoenix Contact product page (phoenixcontact.com)';
  const CARDS = {
    'dek5fw':   { name: 'Weidmüller DEK 5 FW  (5 × 5, horizontal)', w: 5,   h: 5,    rot: 0,  src: WEID, note: 'Pitch 5.00 mm, 10 markers per strip.' },
    'dek5-35':  { name: 'Weidmüller DEK 5/3,5 MC FWZ  (3.5 × 5)',   w: 3.5, h: 5,    rot: 0,  src: WEID, note: 'Pitch 3.50 mm, 5 mm high.' },
    'zb5':      { name: 'Phoenix ZB 5  (5.2 × 10.5)',               w: 5.2, h: 10.5, rot: 90, src: PHX,  note: 'Zack strip, pitch 5.2 mm, text field 5.1 × 10.5 mm, 10 per strip.' },
    'zb6':      { name: 'Phoenix ZB 6  (6.2 × 10.5)',               w: 6.2, h: 10.5, rot: 90, src: PHX,  note: 'Pitch 6.2 mm, text field 6.15 × 10.5 mm.' },
    'zb8':      { name: 'Phoenix ZB 8  (8.2 × 10.5)',               w: 8.2, h: 10.5, rot: 0,  src: PHX,  note: 'Pitch 8.2 mm, text field 7 × 10.5 mm.' },
    'zb10':     { name: 'Phoenix ZB 10  (10.2 × 10.5)',             w: 10.2, h: 10.5, rot: 0, src: PHX,  note: 'Pitch 10.2 mm, text field 10.15 × 10.5 mm.' },
    'zbf5':     { name: 'Phoenix ZBF 5  (5.15 × 6.4, flat)',        w: 5.15, h: 6.4, rot: 0, src: PHX,  note: 'Flat strip, depth 1.6 mm, text field 5.15 × 5.15 mm.' },
    'zbf6':     { name: 'Phoenix ZBF 6  (6.15 × 6.4, flat)',        w: 6.15, h: 6.4, rot: 0, src: PHX,  note: 'Flat strip, text field 5.15 × 6.15 mm.' },
    'zbf8':     { name: 'Phoenix ZBF 8  (8.15 × 6.4, flat)',        w: 8.15, h: 6.4, rot: 0, src: PHX,  note: 'Flat strip, text field 5.15 × 8.15 mm.' },
    'custom':   { name: 'Custom (use the fields below)' },
  };
  $('cardType').innerHTML = Object.entries(CARDS).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('');
  function applyCard(key) {
    const c = CARDS[key]; $('cardNote').textContent = c && c.src ? `${c.note} Source: ${c.src}. Frame size is estimated.` : 'Enter your own cell size below.';
    if (!c || !c.w) return;
    $('cellW').value = c.w; $('cellH').value = c.h;
    $('textH').value = Math.min(3.5, +(c.h * 0.6).toFixed(1)); $('pad').value = 0.6;
    $('rowLen').value = +(c.w * 10).toFixed(1);
    setSeg('rotSeg', c.rot);
  }
  $('cardType').addEventListener('change', () => { applyCard($('cardType').value); relayout(); save(); });
  function cardShape(d, rowGap) {
    const cells = d.cells || [];
    if (!cells.length) return null;
    const bar = Math.max(1, rowGap - CARD.slot);
    const maxX = Math.max(...cells.map(c => c.x + c.w)), minY = Math.min(...cells.map(c => c.y)), maxY = Math.max(...cells.map(c => c.y + c.h));
    const rowsY = [...new Set(cells.map(c => c.y))];
    return {
      frame: { x: -CARD.rail, y: minY - CARD.slot - bar, w: maxX + 2 * CARD.rail, h: maxY - minY + CARD.slot + 2 * bar },
      windows: rowsY.map(y => { const h = cells.find(c => c.y === y).h; return { x: -CARD.clear, y: y - CARD.slot, w: maxX + 2 * CARD.clear, h: h + CARD.slot }; }),
      cells,
    };
  }

  // ---------------------------------------------------------------- preview
  const cv = $('preview'), cx = cv.getContext('2d');
  let geo = { m: 14, scale: 1 };
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function draw() {
    const s0 = settings(), d = state.design, zx = num('zx', 0), zy = num('zy', 0);
    const s = { ...s0, ox: s0.ox + zx, oy: s0.oy + zy };   // design position in bed coordinates
    const dpr = window.devicePixelRatio || 1;
    cv.style.aspectRatio = `${s.bedW} / ${s.bedH}`;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const m = 28, scale = (W - 2 * m) / s.bedW;
    geo = { m, scale, W, H };
    const P = (x, y) => [m + x * scale, H - m - y * scale];

    cx.clearRect(0, 0, W, H);
    cx.fillStyle = css('--sc-low'); cx.beginPath(); cx.roundRect(m, H - m - s.bedH * scale, s.bedW * scale, s.bedH * scale, 18); cx.fill();
    cx.save(); cx.beginPath(); cx.roundRect(m, H - m - s.bedH * scale, s.bedW * scale, s.bedH * scale, 18); cx.clip();
    for (let x = 0; x <= s.bedW; x += 10) { const a = P(x, 0), b = P(x, s.bedH); cx.strokeStyle = css('--outline-variant'); cx.globalAlpha = x % 50 ? .3 : .8; cx.lineWidth = 1; cx.beginPath(); cx.moveTo(a[0], a[1]); cx.lineTo(b[0], b[1]); cx.stroke(); }
    for (let y = 0; y <= s.bedH; y += 10) { const a = P(0, y), b = P(s.bedW, y); cx.globalAlpha = y % 50 ? .3 : .8; cx.beginPath(); cx.moveTo(a[0], a[1]); cx.lineTo(b[0], b[1]); cx.stroke(); }
    cx.globalAlpha = 1;

    // the physical card: ladder frame, slots and white marker cells
    const p0 = P(s.ox, s.oy), p1 = P(s.ox + d.width, s.oy + d.height);
    const shape = cardShape(d, num('rowGap', 4));
    if (shape) {
      const R = (r) => { const a1 = P(s.ox + r.x, s.oy + r.y), b1 = P(s.ox + r.x + r.w, s.oy + r.y + r.h); return [a1[0], b1[1], b1[0] - a1[0], a1[1] - b1[1]]; };
      cx.fillStyle = '#f1f3f6'; cx.strokeStyle = '#b9bfc8'; cx.lineWidth = 1;
      let r = R(shape.frame); cx.beginPath(); cx.roundRect(r[0], r[1], r[2], r[3], 3); cx.fill(); cx.stroke();
      cx.fillStyle = css('--sc-low');
      for (const w of shape.windows) { r = R(w); cx.fillRect(r[0], r[1], r[2], r[3]); cx.strokeRect(r[0] + .5, r[1] + .5, r[2] - 1, r[3] - 1); }
      cx.fillStyle = '#ffffff';
      for (const c of shape.cells) { r = R(c); cx.fillRect(r[0], r[1], r[2], r[3]); cx.strokeRect(r[0] + .5, r[1] + .5, r[2] - 1, r[3] - 1); }
    }
    if (state.outOfBed) { cx.strokeStyle = css('--error'); cx.lineWidth = 2; cx.setLineDash([6, 4]); cx.strokeRect(p0[0] - 2, p1[1] - 2, p1[0] - p0[0] + 4, p0[1] - p1[1] + 4); cx.setLineDash([]); }

    cx.lineCap = 'round'; cx.lineJoin = 'round';
    const INK = '#0b3d91', DONE = '#00696b';
    const pv = state.pv;
    if (pv) {
      // moves preview: every pen-up travel (dashed) and pen-down stroke, animated up to pv.pos
      let left = pv.pos;
      cx.lineWidth = Math.max(1.4, 0.45 * scale);
      for (const mv of pv.moves) {
        if (left <= 0) break;
        const use = Math.min(left, mv.len); left -= use;
        const pts = pointsUpTo(mv.pts, use);
        cx.beginPath();
        pts.forEach((pt, k) => { const a = P(zx + pt[0], zy + pt[1]); k ? cx.lineTo(a[0], a[1]) : cx.moveTo(a[0], a[1]); });
        if (mv.bad) { cx.setLineDash([]); cx.strokeStyle = css('--error'); cx.globalAlpha = 1; cx.lineWidth = 2.5; }
        else if (mv.down) { cx.setLineDash([]); cx.strokeStyle = INK; cx.globalAlpha = 1; cx.lineWidth = Math.max(1.4, 0.45 * scale); }
        else { cx.setLineDash([4, 3]); cx.strokeStyle = css('--tertiary'); cx.globalAlpha = .9; cx.lineWidth = 1.2; }
        cx.stroke();
        if (left <= 0) { const e = P(zx + pts[pts.length - 1][0], zy + pts[pts.length - 1][1]); cx.setLineDash([]); cx.globalAlpha = 1; cx.fillStyle = mv.down ? INK : css('--tertiary'); cx.beginPath(); cx.arc(e[0], e[1], 4, 0, 7); cx.fill(); }
      }
      cx.setLineDash([]); cx.globalAlpha = 1;
    } else {
      if ($('showTravel').checked) {
        cx.strokeStyle = css('--tertiary'); cx.globalAlpha = .6; cx.lineWidth = 1; cx.setLineDash([3, 3]); cx.beginPath();
        let cur = P(zx, zy); cx.moveTo(cur[0], cur[1]);
        for (const st of d.strokes) { const a = P(s.ox + st[0][0], s.oy + st[0][1]); cx.lineTo(a[0], a[1]); const b = P(s.ox + st[st.length - 1][0], s.oy + st[st.length - 1][1]); cx.moveTo(b[0], b[1]); }
        cx.stroke(); cx.setLineDash([]); cx.globalAlpha = 1;
      }
      cx.lineWidth = Math.max(1.4, 0.45 * scale);
      d.strokes.forEach((st, i) => {
        cx.strokeStyle = i < state.doneStrokes ? DONE : INK;
        cx.beginPath();
        st.forEach((pt, k) => { const a = P(s.ox + pt[0], s.oy + pt[1]); k ? cx.lineTo(a[0], a[1]) : cx.moveTo(a[0], a[1]); });
        cx.stroke();
      });
    }
    // toolpath safety overlay: travel envelope, zero point, problem moves
    const pth = state.path;
    if (pth && !state.pv) {
      const b = pth.bbox, e0 = P(zx + b.minX, zy + b.minY), e1 = P(zx + b.maxX, zy + b.maxY);
      cx.setLineDash([5, 4]); cx.strokeStyle = pth.errors ? css('--error') : css('--tertiary'); cx.lineWidth = 1.2; cx.globalAlpha = .9;
      cx.strokeRect(e0[0], e1[1], e1[0] - e0[0], e0[1] - e1[1]); cx.setLineDash([]); cx.globalAlpha = 1;
      cx.strokeStyle = css('--error'); cx.lineWidth = 2.5;
      for (const sg of pth.segs) if (sg.bad) { const a1 = P(zx + sg.x0, zy + sg.y0), b1 = P(zx + sg.x1, zy + sg.y1); cx.beginPath(); cx.moveTo(a1[0], a1[1]); cx.lineTo(b1[0], b1[1]); cx.stroke(); }
    }
    { const z0 = P(zx, zy); cx.strokeStyle = css('--on-surface'); cx.lineWidth = 1.5; cx.beginPath(); cx.moveTo(z0[0] - 7, z0[1]); cx.lineTo(z0[0] + 7, z0[1]); cx.moveTo(z0[0], z0[1] - 7); cx.lineTo(z0[0], z0[1] + 7); cx.stroke(); cx.beginPath(); cx.arc(z0[0], z0[1], 4, 0, 7); cx.stroke(); }
    cx.restore();
    if (pth && pth.issues.some(i => i.text.startsWith('Moves outside'))) { cx.strokeStyle = css('--error'); cx.lineWidth = 3; cx.beginPath(); cx.roundRect(m, H - m - s.bedH * scale, s.bedW * scale, s.bedH * scale, 18); cx.stroke(); }

    // axis labels
    cx.fillStyle = css('--on-surface-variant'); cx.font = '500 11px Roboto Flex, sans-serif'; cx.textAlign = 'center';
    for (let x = 0; x <= s.bedW; x += 50) cx.fillText(x, P(x, 0)[0], H - 3);
    cx.textAlign = 'right';
    for (let y = 50; y <= s.bedH; y += 50) cx.fillText(y, m - 3, P(0, y)[1] + 4);
  }
  // ---- move preview (simulated pen run) ----
  function pointsUpTo(pts, dist) {
    const out = [pts[0]]; let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (acc + seg >= dist) { const t = seg ? (dist - acc) / seg : 0; out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]); return out; }
      acc += seg; out.push(pts[i]);
    }
    return out;
  }
  function buildMoves() {
    const moves = []; let total = 0;
    for (const sg of state.path.segs) {
      const len = Math.hypot(sg.x1 - sg.x0, sg.y1 - sg.y0); if (len < 1e-3) continue;
      moves.push({ pts: [[sg.x0, sg.y0], [sg.x1, sg.y1]], len, down: sg.down, bad: sg.bad }); total += len;
    }
    return { moves, total };
  }
  let pvRaf = 0;
  function stopPreview(keep) {
    cancelAnimationFrame(pvRaf); pvRaf = 0;
    if (!keep) state.pv = null;
    $('btnPreview').querySelector('span').textContent = state.pv ? 'Replay moves' : 'Preview moves';
    draw();
  }
  function startPreview() {
    if (!state.design.strokes.length) return;
    const { moves, total } = buildMoves();
    const speed = Math.max(total / 8, 60);            // whole run takes ~8 s, never slower than 60 mm/s
    state.pv = { moves, total, pos: 0 };
    $('btnPreview').querySelector('span').textContent = 'Skip to end';
    let last = performance.now();
    const step = now => {
      const pv = state.pv; if (!pv) return;
      pv.pos = Math.min(pv.total, pv.pos + (now - last) / 1000 * speed); last = now;
      draw();
      if (pv.pos < pv.total) pvRaf = requestAnimationFrame(step); else stopPreview(true);
    };
    pvRaf = requestAnimationFrame(step);
  }
  $('btnPreview').onclick = () => {
    if (pvRaf) { state.pv.pos = state.pv.total; stopPreview(true); } else startPreview();
  };
  window.addEventListener('resize', () => { draw(); drawBlocks(); drawProfile(); });
  function setTheme(t, persist) {
    document.documentElement.dataset.theme = t;
    if (persist) { try { localStorage.setItem('drawbot.theme', t); } catch (e) { /* private mode */ } }
    draw(); drawBlocks(); drawProfile(); kickWave();
  }
  $('btnTheme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    let saved = null; try { saved = localStorage.getItem('drawbot.theme'); } catch (_) { /* ignore */ }
    if (!saved) setTheme(e.matches ? 'dark' : 'light', false);
  });

  // ---------------------------------------------------------------- marker card visualisation
  const tv = $('tbView'), tx = tv.getContext('2d');
  function drawBlocks() {
    const o = layoutOpts(), d = state.design, shape = d && cardShape(d, num('rowGap', 4));
    const dpr = window.devicePixelRatio || 1, W = tv.clientWidth;
    if (!W) return;
    if (!shape) { tv.style.height = '90px'; tv.width = W * dpr; tv.height = 90 * dpr; tx.setTransform(dpr, 0, 0, dpr, 0, 0); tx.fillStyle = css('--on-surface-variant'); tx.font = '500 14px Roboto Flex, sans-serif'; tx.textAlign = 'center'; tx.fillText('Add some labels to see them here', W / 2, 50); return; }
    const f = shape.frame, pad = 16, k = Math.min((W - 2 * pad) / f.w, 14);
    const H = Math.ceil(f.h * k + 2 * pad);
    tv.style.height = H + 'px'; tv.width = W * dpr; tv.height = H * dpr;
    tx.setTransform(dpr, 0, 0, dpr, 0, 0); tx.clearRect(0, 0, W, H);
    const ox = (W - f.w * k) / 2 - f.x * k, oy = pad + (f.y + f.h) * k;     // design (x,y up) -> px
    const R = r => [ox + r.x * k, oy - (r.y + r.h) * k, r.w * k, r.h * k];
    const dark = document.documentElement.dataset.theme === 'dark';
    const frame = dark ? '#e4e7eb' : '#f6f7f9', edge = dark ? '#9aa1ab' : '#b9bfc8';
    tx.lineWidth = 1; tx.strokeStyle = edge; tx.fillStyle = frame;
    let r = R(f); tx.beginPath(); tx.roundRect(r[0], r[1], r[2], r[3], 4); tx.fill(); tx.stroke();
    // register holes in the rails
    tx.fillStyle = dark ? '#aeb4bd' : '#cfd4db';
    for (const w of shape.windows) { const cy = oy - (w.y + w.h / 2) * k; for (const hx of [ox - CARD.rail / 2 * k, ox + (f.x + f.w - CARD.rail / 2 + 0) * k + 0]) { tx.beginPath(); tx.arc(hx === ox - CARD.rail / 2 * k ? hx : ox + (f.x + f.w - CARD.rail / 2) * k, cy, Math.max(1.5, .6 * k), 0, 7); tx.fill(); } }
    tx.fillStyle = css('--sc-highest');
    for (const w of shape.windows) { r = R(w); tx.fillRect(r[0], r[1], r[2], r[3]); tx.strokeRect(r[0] + .5, r[1] + .5, r[2] - 1, r[3] - 1); }
    for (const c of shape.cells) {
      r = R(c); tx.fillStyle = '#ffffff'; tx.fillRect(r[0], r[1], r[2], r[3]); tx.strokeStyle = edge; tx.strokeRect(r[0] + .5, r[1] + .5, r[2] - 1, r[3] - 1);
    }
    const lab = window.DBLayout.parseLabels($('labels').value, o.cellW);
    shape.cells.forEach((c, i) => {
      const L0 = lab[i]; if (!L0) return;
      r = R(c);
      tx.save(); tx.beginPath(); tx.rect(r[0] + 1, r[1] + 1, r[2] - 2, r[3] - 2); tx.clip();
      tx.translate(r[0] + r[2] / 2, r[1] + r[3] / 2); if (o.rot) tx.rotate(-o.rot * Math.PI / 180);
      const Lx = (o.rot ? r[3] : r[2]) - 6, T = (o.rot ? r[2] : r[3]) - 6, n = L0.lines.length;
      let fs = Math.min(T / (n * 1.2), o.textH * k * 1.3, 40);
      tx.fillStyle = '#14171c'; tx.textAlign = 'center'; tx.textBaseline = 'middle';
      const font = z => `500 ${z}px Arial, Helvetica, sans-serif`;
      tx.font = font(fs);
      const widest = Math.max(0, ...L0.lines.map(t => tx.measureText(t).width));
      if (widest > Lx) { fs *= Lx / widest; tx.font = font(fs); }
      L0.lines.forEach((t, j) => tx.fillText(t, 0, (j - (n - 1) / 2) * fs * 1.2));
      tx.restore();
    });
  }

  // drag the drawing around the bed
  let drag = null;
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); cv.classList.add('drag'); drag = { x: e.clientX, y: e.clientY, ox: num('ox', 0), oy: num('oy', 0) }; });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    const k = geo.scale * (cv.getBoundingClientRect().width / geo.W);
    const nx = Math.round((drag.ox + (e.clientX - drag.x) / k) * 2) / 2, ny = Math.round((drag.oy - (e.clientY - drag.y) / k) * 2) / 2;
    $('ox').value = Math.max(0, nx); $('oy').value = Math.max(0, ny);
    regen();
  });
  const endDrag = () => { if (drag) { drag = null; cv.classList.remove('drag'); save(); } };
  cv.addEventListener('pointerup', endDrag); cv.addEventListener('pointercancel', endDrag);

  // ---------------------------------------------------------------- wavy progress (expressive)
  const wv = $('wave'), wx = wv.getContext('2d');
  let amp = 0, phase = 0, wavePct = 0, waveRun = false, waveRaf = 0;
  function drawWave() {
    const dpr = window.devicePixelRatio || 1, W = wv.clientWidth, H = 28;
    if (wv.width !== W * dpr) { wv.width = W * dpr; wv.height = H * dpr; }
    wx.setTransform(dpr, 0, 0, dpr, 0, 0); wx.clearRect(0, 0, W, H);
    const col = css('--on-primary-container'), act = css('--primary');
    const x1 = 6 + (W - 12) * wavePct, mid = H / 2;
    wx.lineCap = 'round'; wx.lineWidth = 5;
    wx.strokeStyle = col; wx.globalAlpha = .25; wx.beginPath(); wx.moveTo(x1 + 8, mid); wx.lineTo(W - 6, mid); wx.stroke(); wx.globalAlpha = 1;
    wx.strokeStyle = act; wx.beginPath();
    for (let x = 6; x <= x1; x += 2) { const y = mid + Math.sin((x / 26) * Math.PI * 2 - phase) * amp; x === 6 ? wx.moveTo(x, y) : wx.lineTo(x, y); }
    if (x1 <= 6) wx.lineTo(6.01, mid);
    wx.stroke();
    const target = waveRun ? 5 : 0;
    amp += (target - amp) * 0.12; phase += waveRun ? 0.12 : 0;
    waveRaf = (waveRun || Math.abs(amp - target) > 0.05) ? requestAnimationFrame(drawWave) : 0;
  }
  const kickWave = () => { if (!waveRaf) waveRaf = requestAnimationFrame(drawWave); };
  window.addEventListener('resize', kickWave);

  // ---------------------------------------------------------------- connection
  const chip = $('statusChip');
  function setStatus(kind, text) { chip.className = 'chip ' + kind; $('statusText').textContent = text; }
  printer.onLog = (t, txt, quiet) => { if (!quiet) log(t, txt); };
  printer.onState = st => {
    const btn = $('btnConnect');
    $('blob').classList.toggle('busy', st === 'connecting');
    if (st === 'connecting') { setStatus('warn', 'Connecting…'); btn.disabled = true; }
    if (st === 'ready') { setStatus('ok', 'Connected · ' + printer.firmware); setConnBtn(true); toast('Connected to ' + printer.firmware); }
    if (st === 'silent') { setStatus('warn', 'Connected, no reply'); setConnBtn(true); toast('Port open but Marlin did not answer — check the baud rate.'); }
    if (st === 'halted') { setStatus('err', 'Printer halted — reset it'); toast('Marlin halted. Power-cycle the printer, then reconnect.'); }
    if (st === 'disconnected') { setStatus('', 'Not connected'); setConnBtn(false); endJobUI(false); state.homed = false; }
    if (st === 'paused-idle') $('progText').textContent = 'Paused';
  };
  function setConnBtn(on) {
    const b = $('btnConnect'); b.disabled = false; b.className = 'btn ' + (on ? 'tonal' : 'filled');
    b.querySelector('span').textContent = on ? 'Disconnect' : 'Connect';
  }
  $('btnConnect').addEventListener('click', async () => {
    if (printer.connected) { await printer.disconnect(); return; }
    try { await printer.connect(parseInt($('baud').value, 10)); }
    catch (e) { setConnBtn(false); setStatus('', 'Not connected'); $('blob').classList.remove('busy'); if (e.name !== 'NotFoundError') toast('Could not open port: ' + e.message); try { await printer.disconnect(); } catch (_) { /* ignore */ } }
  });
  if (!window.DBPrinter.supported()) {
    setStatus('err', 'Use Chrome or Edge (Web Serial)'); $('btnConnect').disabled = true;
  }
  navigator.serial && navigator.serial.addEventListener('disconnect', () => { if (printer.connected) printer.cleanup(); });

  // ---------------------------------------------------------------- machine controls
  function need() { if (!printer.connected) { toast('Connect to the printer first.'); return false; } if (state.job && state.job.running) { toast('A job is running — pause or stop it first.'); return false; } return true; }
  const send = (lines, tags) => printer.enqueue(lines, tags);
  const penUpCmds = () => GC.penUp(settings());
  const liftCmds = () => segVal('modeSeg') === 'servo' ? penUpCmds() : ['G91', 'G0 Z3 F600', 'G90'];

  $('btnZero').onclick = () => { if (!need()) return; send(['G92 X0 Y0 Z0', ...liftCmds()]); state.homed = true; state.zSet = true; toast('This position is now 0 X Y Z.'); };
  $('btnGoZero').onclick = () => { if (!need()) return; send([...liftCmds(), 'G90', `G0 X0 Y0 F${settings().travelFeed}`]); };
  $('btnOff').onclick = () => { if (!need()) return; send(['M84']); state.homed = false; };
  $('btnSetZ').onclick = () => { if (!need()) return; send(['G92 Z0']); state.zSet = true; toast('Z = 0 is now the paper surface.'); };
  $('btnPenUp').onclick = () => { if (!need()) return; send(['G90', ...penUpCmds()]); };
  $('btnPenDown').onclick = () => { if (!need()) return; send(['G90', ...GC.penDown(settings())]); };
  $('btnBounds').onclick = () => {
    if (!need()) return;
    const s = settings(), d = state.design, f = GC.f;
    const pts = [[0, 0], [d.width, 0], [d.width, d.height], [0, d.height], [0, 0]];
    send(['G90', ...penUpCmds(), ...pts.map(([x, y]) => `G0 X${f(s.ox + x)} Y${f(s.oy + y)} F${f(s.travelFeed)}`)]);
  };
  document.querySelectorAll('[data-jog]').forEach(b => b.addEventListener('click', () => {
    if (!need()) return;
    const ax = b.dataset.jog, step = parseFloat(segVal('stepSeg')) * parseInt(b.dataset.dir, 10);
    const feed = ax === 'Z' ? 300 : 4000;
    send(['G91', `G0 ${ax}${step} F${feed}`, 'G90']);
  }));
  $('cmdForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('cmd').value.trim(); if (!v) return;
    if (!printer.connected) { toast('Connect to the printer first.'); return; }
    printer.sendNow(v); $('cmd').value = '';
  });

  // ---------------------------------------------------------------- job
  function jobUI(running) {
    $('btnStart').disabled = running; $('btnPause').disabled = !running; $('btnStop').disabled = !running;
    $('btnPause').querySelector('span').textContent = 'Pause';
    waveRun = running; kickWave();
  }
  function endJobUI(done) {
    if (state.job) state.job.running = false;
    jobUI(false);
    if (done) { wavePct = 1; $('progText').textContent = `Done — ${state.design.count} labels drawn`; $('progPct').textContent = '100%'; toast('Finished drawing.'); }
    else { $('progText').textContent = 'Ready'; $('progPct').textContent = ''; wavePct = 0; }
    kickWave();
  }
  $('btnStart').onclick = async () => {
    if (!need()) return;
    if (!state.design.strokes.length) { toast('Nothing to draw — add some labels.'); return; }
    const warn = [];
    if (state.outOfBed) warn.push('• The drawing extends past the bed.');
    (state.path ? state.path.issues : []).forEach(i => warn.push('• ' + i.text + (i.count > 1 ? ` (${i.count} moves)` : '')));
    if (!state.homed) warn.push('• Zero (Set 0 XYZ) has not been set this session.');
    if (settings().penMode === 'z' && !state.zSet) warn.push('• Paper height (Z = 0) has not been set.');
    if (warn.length && !(await confirmDlg('Check before drawing', warn.join('\n') + '\n\nThe pen may crash or draw in the wrong place.', 'Draw anyway'))) return;
    const gc = state.gc;
    state.job = { running: true, total: gc.lines.length, acked: 0, strokeOf: gc.strokeOf, lastTag: gc.lines.length - 1 };
    state.doneStrokes = 0; wavePct = 0;
    jobUI(true); $('progText').textContent = 'Drawing…';
    printer.enqueue(gc.lines, gc.lines.map((_, i) => i));
  };
  printer.onAck = tag => {
    const j = state.job; if (!j || !j.running || tag < 0) return;
    j.acked++;
    state.doneStrokes = Math.max(0, j.strokeOf[tag]);
    wavePct = j.acked / j.total;
    $('progPct').textContent = Math.floor(wavePct * 100) + '%';
    if (tag >= j.lastTag) { state.doneStrokes = state.design.strokes.length; endJobUI(true); }
    if (!(tag & 7)) draw();
  };
  $('btnPause').onclick = () => {
    const p = $('btnPause').querySelector('span');
    if (!printer.paused) { $('progText').textContent = 'Pausing…'; p.textContent = 'Resume'; printer.pause(); }
    else { printer.resume(); p.textContent = 'Pause'; $('progText').textContent = 'Drawing…'; }
  };
  $('btnStop').onclick = async () => {
    await printer.stop(['G90', ...penUpCmds()]);
    endJobUI(false); state.doneStrokes = 0; draw(); toast('Stopped. Pen lifted.');
  };
  $('btnDownload').onclick = () => {
    const blob = new Blob([state.gc.lines.join('\n') + '\n'], { type: 'text/plain' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'drawbot-labels.gcode'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  // ---------------------------------------------------------------- labels helpers
  $('btnGen').onclick = () => {
    const pre = $('genPrefix').value, suf = $('genSuffix').value, st = parseInt($('genStart').value, 10) || 0, n = Math.max(1, parseInt($('genCount').value, 10) || 1);
    const add = Array.from({ length: n }, (_, i) => pre + (st + i) + suf).join('\n');
    const t = $('labels'); t.value = (t.value && !t.value.endsWith('\n') ? t.value + '\n' : t.value) + add;
    relayout(); save();
  };
  $('btnClear').onclick = () => { $('labels').value = ''; relayout(); save(); };

  // ---------------------------------------------------------------- wiring
  const DESIGN_IDS = ['labels', 'cellW', 'cellH', 'textH', 'pad', 'rowLen', 'rowGap', 'borders', 'shrink'];
  DESIGN_IDS.forEach(id => $(id).addEventListener('input', () => { relayout(); save(); }));
  ['zUp', 'zDown', 'zFeed', 'svUp', 'svDown', 'svDelay', 'drawFeed', 'travelFeed', 'ox', 'oy', 'zx', 'zy', 'bedW', 'bedH', 'showTravel', 'baud', 'genPrefix', 'genStart', 'genCount', 'genSuffix']
    .forEach(id => $(id).addEventListener('input', () => { regen(); save(); }));

  load(); syncMode();
  { const c = CARDS[$('cardType').value]; $('cardNote').textContent = c && c.src ? `${c.note} Source: ${c.src}. Frame size is estimated.` : 'Enter your own cell size below.'; }
  ['cellW', 'cellH'].forEach(id => $(id).addEventListener('input', () => { $('cardType').value = 'custom'; $('cardNote').textContent = 'Enter your own cell size below.'; }));
  Object.keys(SEGS).forEach(id => setSeg(id, segVal(id)));
  relayout(); kickWave();
  window.DBApp = { state, settings, printer };
  log('sys', 'Ready. Connect over USB, home X Y, set the paper height, then draw.');
})();
