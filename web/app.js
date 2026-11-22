/* Drawbot Labels — UI glue. */
(function () {
  const $ = id => document.getElementById(id);
  const { layout } = window.DBLayout;
  const GC = window.DBGcode;
  const printer = new window.DBPrinter();

  // ---------------------------------------------------------------- state
  const SAVE_KEY = 'drawbot.settings.v1';
  const NUM_IDS = ['cellW', 'cellH', 'textH', 'pad', 'rowLen', 'rowGap', 'zUp', 'zDown', 'zFeed', 'svUp', 'svDown', 'svDelay',
                   'drawFeed', 'travelFeed', 'ox', 'oy', 'bedW', 'bedH'];
  const CHECK_IDS = ['borders', 'shrink', 'showTravel'];
  const SEGS = { rotSeg: '90', modeSeg: 'z', stepSeg: '10' };
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
      ox: num('ox', 20), oy: num('oy', 20), bedW, bedH, parkX: 0, parkY: bedH,
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
    NUM_IDS.concat(['genPrefix', 'genStart', 'genCount', 'genSuffix', 'baud']).forEach(i => (o[i] = $(i).value));
    CHECK_IDS.forEach(i => (o[i] = $(i).checked));
    Object.keys(SEGS).forEach(i => (o.seg[i] = segVal(i)));
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(o)); } catch (e) { /* private mode */ }
  }
  function load() {
    $('labels').value = '1\n2\n3\n4\n5\n6\n7\n8\nL+\nL-\nPE@8';
    let o; try { o = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { o = null; }
    if (!o) return;
    if (typeof o.labels === 'string') $('labels').value = o.labels;
    NUM_IDS.concat(['genPrefix', 'genStart', 'genCount', 'genSuffix', 'baud']).forEach(i => { if (o[i] !== undefined) $(i).value = o[i]; });
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
    if (id === 'rotSeg') relayout(); else regen();
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
  (function blob(lobes = 9, depth = 0.09) {
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
    draw(); drawBlocks();
  }

  // ---------------------------------------------------------------- preview
  const cv = $('preview'), cx = cv.getContext('2d');
  let geo = { m: 14, scale: 1 };
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  function draw() {
    const s = settings(), d = state.design;
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

    // paper footprint
    const p0 = P(s.ox, s.oy), p1 = P(s.ox + d.width, s.oy + d.height);
    cx.fillStyle = css('--primary-container'); cx.globalAlpha = .55;
    cx.beginPath(); cx.roundRect(p0[0] - 4, p1[1] - 4, p1[0] - p0[0] + 8, p0[1] - p1[1] + 8, 8); cx.fill(); cx.globalAlpha = 1;
    if (state.outOfBed) { cx.strokeStyle = css('--error'); cx.lineWidth = 2; cx.setLineDash([6, 4]); cx.strokeRect(p0[0] - 4, p1[1] - 4, p1[0] - p0[0] + 8, p0[1] - p1[1] + 8); cx.setLineDash([]); }

    cx.lineCap = 'round'; cx.lineJoin = 'round';
    if ($('showTravel').checked) {
      cx.strokeStyle = css('--tertiary'); cx.globalAlpha = .45; cx.lineWidth = 1; cx.setLineDash([3, 3]); cx.beginPath();
      let cur = P(0, 0); cx.moveTo(cur[0], cur[1]);
      for (const st of d.strokes) { const a = P(s.ox + st[0][0], s.oy + st[0][1]); cx.lineTo(a[0], a[1]); const b = P(s.ox + st[st.length - 1][0], s.oy + st[st.length - 1][1]); cx.moveTo(b[0], b[1]); }
      cx.stroke(); cx.setLineDash([]); cx.globalAlpha = 1;
    }
    cx.lineWidth = Math.max(1.4, 0.45 * scale);
    d.strokes.forEach((st, i) => {
      cx.strokeStyle = i < state.doneStrokes ? css('--tertiary') : css('--primary');
      cx.beginPath();
      st.forEach((pt, k) => { const a = P(s.ox + pt[0], s.oy + pt[1]); k ? cx.lineTo(a[0], a[1]) : cx.moveTo(a[0], a[1]); });
      cx.stroke();
    });
    cx.restore();

    // axis labels
    cx.fillStyle = css('--on-surface-variant'); cx.font = '500 11px Roboto Flex, sans-serif'; cx.textAlign = 'center';
    for (let x = 0; x <= s.bedW; x += 50) cx.fillText(x, P(x, 0)[0], H - 3);
    cx.textAlign = 'right';
    for (let y = 50; y <= s.bedH; y += 50) cx.fillText(y, m - 3, P(0, y)[1] + 4);
  }
  window.addEventListener('resize', () => { draw(); drawBlocks(); });
  function setTheme(t, persist) {
    document.documentElement.dataset.theme = t;
    if (persist) { try { localStorage.setItem('drawbot.theme', t); } catch (e) { /* private mode */ } }
    draw(); drawBlocks(); kickWave();
  }
  $('btnTheme').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    let saved = null; try { saved = localStorage.getItem('drawbot.theme'); } catch (_) { /* ignore */ }
    if (!saved) setTheme(e.matches ? 'dark' : 'light', false);
  });

  // ---------------------------------------------------------------- terminal block visualisation
  const tv = $('tbView'), tx = tv.getContext('2d');
  function drawBlocks() {
    const o = layoutOpts(), cells = window.DBLayout.parseLabels($('labels').value, o.cellW);
    const dpr = window.devicePixelRatio || 1, W = tv.clientWidth;
    if (!W) return;
    const pad = 20, avail = W - 2 * pad;
    // wrap cells into rows (same rule as the plot layout, fitted to the card width)
    const rows = []; let row = [], x = 0, maxLen = 0;
    const cap = Math.max(o.rowLen, 1);
    for (const c of cells) {
      if (row.length && x + c.w > cap + 1e-6) { rows.push(row); maxLen = Math.max(maxLen, x); row = []; x = 0; }
      row.push(c); x += c.w;
    }
    if (row.length) { rows.push(row); maxLen = Math.max(maxLen, x); }
    const k = Math.min(avail / Math.max(maxLen, 1), 9);          // px per mm
    const blockH = Math.max(o.cellH * k, 70), railH = 16, rowH = blockH + railH * 2 + 28;
    const H = Math.max(rows.length, 1) * rowH + 12;
    tv.style.height = H + 'px'; tv.width = W * dpr; tv.height = H * dpr;
    tx.setTransform(dpr, 0, 0, dpr, 0, 0); tx.clearRect(0, 0, W, H);
    if (!rows.length) { tx.fillStyle = css('--on-surface-variant'); tx.font = '500 14px Roboto Flex, sans-serif'; tx.textAlign = 'center'; tx.fillText('Add some labels to see them here', W / 2, H / 2); return; }
    const dark = document.documentElement.dataset.theme === 'dark';
    const body = dark ? '#3a3f47' : '#c9ced6', bodyEdge = dark ? '#5a616c' : '#8f97a3';
    const marker = '#f4f1e8', ink = '#14171c';
    const rail = dark ? '#8a929e' : '#a9b0ba', railEdge = dark ? '#5c636d' : '#7b838f';
    rows.forEach((r, ri) => {
      const total = r.reduce((s, c) => s + c.w, 0) * k, x0 = (W - total) / 2, y0 = 8 + ri * rowH + 14 + railH;
      // DIN rail behind the blocks
      const ry = y0 + blockH / 2 - railH / 2;
      tx.fillStyle = rail; tx.strokeStyle = railEdge; tx.lineWidth = 1;
      tx.beginPath(); tx.roundRect(x0 - 14, ry, total + 28, railH, 3); tx.fill(); tx.stroke();
      tx.fillStyle = css('--sc-highest');
      for (let sx = x0 - 6; sx < x0 + total + 6; sx += 26) { tx.beginPath(); tx.roundRect(sx, ry + 4, 14, railH - 8, 4); tx.fill(); }
      let x = x0;
      for (const c of r) {
        const w = c.w * k - 1.5, earth = c.lines.join('').toUpperCase() === 'PE';
        // block body
        tx.fillStyle = earth ? '#c6b829' : body; tx.strokeStyle = bodyEdge; tx.lineWidth = 1;
        tx.beginPath(); tx.roundRect(x, y0, w, blockH, 5); tx.fill(); tx.stroke();
        if (earth) { tx.fillStyle = '#2f8f4e'; tx.fillRect(x + 1, y0 + blockH * .55, w - 2, blockH * .45 - 1); }
        // screw head + wire entry
        const sr = Math.min(w * .3, 11), sy = y0 + sr + 7;
        tx.fillStyle = dark ? '#20242a' : '#7c8591'; tx.beginPath(); tx.arc(x + w / 2, sy, sr, 0, 7); tx.fill();
        tx.strokeStyle = dark ? '#aeb5c0' : '#eef0f3'; tx.lineWidth = 1.6; tx.beginPath(); tx.moveTo(x + w / 2 - sr * .6, sy); tx.lineTo(x + w / 2 + sr * .6, sy); tx.stroke();
        tx.fillStyle = dark ? '#20242a' : '#7c8591'; tx.beginPath(); tx.roundRect(x + w * .25, y0 + blockH - 9, w * .5, 5, 2); tx.fill();
        // marker strip with the label
        const my = y0 + sr * 2 + 16, mh = blockH - (sr * 2 + 16) - 16;
        if (mh > 14) {
          tx.fillStyle = marker; tx.strokeStyle = bodyEdge; tx.beginPath(); tx.roundRect(x + 2, my, w - 4, mh, 3); tx.fill(); tx.stroke();
          tx.save(); tx.beginPath(); tx.rect(x + 2, my, w - 4, mh); tx.clip();
          tx.translate(x + w / 2, my + mh / 2); if (o.rot) tx.rotate(o.rot * Math.PI / 180 * -1);
          const L = (o.rot ? mh : w - 4) - 6, T = (o.rot ? w - 4 : mh) - 4, n = c.lines.length;
          let fs = Math.min(T / (n * 1.15), o.textH * k * 1.2, 30);
          tx.fillStyle = ink; tx.textAlign = 'center'; tx.textBaseline = 'middle';
          const font = s => `700 ${s}px "Roboto Mono", ui-monospace, monospace`;
          tx.font = font(fs);
          const widest = Math.max(0, ...c.lines.map(t => tx.measureText(t).width));
          if (widest > L) { fs *= L / widest; tx.font = font(fs); }
          c.lines.forEach((t, i) => tx.fillText(t, 0, (i - (n - 1) / 2) * fs * 1.15));
          tx.restore();
        }
        x += c.w * k;
      }
      // end stops
      tx.fillStyle = dark ? '#6b7380' : '#5d6672';
      [x0 - 8, x0 + total + 2].forEach(ex => { tx.beginPath(); tx.roundRect(ex, y0 + 4, 6, blockH - 8, 2); tx.fill(); });
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

  $('btnHome').onclick = () => { if (!need()) return; send([...liftCmds(), 'G28 X Y']); state.homed = true; };
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
    if (!state.homed) warn.push('• X/Y have not been homed this session.');
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
  ['zUp', 'zDown', 'zFeed', 'svUp', 'svDown', 'svDelay', 'drawFeed', 'travelFeed', 'ox', 'oy', 'bedW', 'bedH', 'showTravel', 'baud', 'genPrefix', 'genStart', 'genCount', 'genSuffix']
    .forEach(id => $(id).addEventListener('input', () => { regen(); save(); }));

  load(); syncMode();
  Object.keys(SEGS).forEach(id => setSeg(id, segVal(id)));
  relayout(); kickWave();
  window.DBApp = { state, settings, printer };
  log('sys', 'Ready. Connect over USB, home X Y, set the paper height, then draw.');
})();
