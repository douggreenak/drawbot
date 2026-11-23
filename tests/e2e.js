/* End-to-end tests: real UI (headless Chrome) -> layout -> G-code -> streaming -> simulated Marlin.
   Writes screenshots to docs/screenshots and a report to docs/TEST_RESULTS.md.
   Usage: npm install && npm test   (CHROME=/path/to/chrome to override the browser) */
const http = require('http'), fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web'), SHOTS = path.join(ROOT, 'docs', 'screenshots');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(SHOTS, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const f = path.join(WEB, req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!f.startsWith(WEB) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' }); res.end(fs.readFileSync(f));
});

const results = [];          // {group, name, pass, detail}
const check = (group, name, pass, detail = '') => { results.push({ group, name, pass: !!pass, detail }); console.log(`${pass ? '  ok ' : ' FAIL'}  [${group}] ${name} ${detail}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DATASETS = [
  { id: 'numbered', title: 'Numbered marker strips, 5 mm cells',
    labels: Array.from({ length: 24 }, (_, i) => String(i + 1)).join('\n'),
    num: { cellW: 5, cellH: 8, textH: 3.5, rowLen: 50, rowGap: 8 }, seg: { rotSeg: '0', modeSeg: 'z' } },
  { id: 'symbols', title: 'Mixed symbols and two-line labels',
    labels: 'L1|24V\nL2|24V\n0V\nPE@8\n10kΩ\n4.7µF\n±5%\n85°C\nA-B/C\n(IN)+\n#7 &8', num: { cellW: 9, cellH: 14, textH: 3.5 }, seg: { rotSeg: '90', modeSeg: 'z' } },
  { id: 'horizontal', title: 'Horizontal text in wide cells',
    labels: 'IN1\nIN2\nOUT1\nOUT2\nGND\n+24V\nSHIELD', num: { cellW: 16, cellH: 9, textH: 4.5, rowLen: 100 }, seg: { rotSeg: '0', modeSeg: 'z' } },
  { id: 'servo', title: 'Servo pen lift, 40 labels in rows',
    labels: Array.from({ length: 40 }, (_, i) => String(i + 1)).join('\n'), num: { cellW: 5, cellH: 10, textH: 3, rowLen: 100 }, seg: { rotSeg: '90', modeSeg: 'servo' } },
  { id: 'single', title: 'Edge case: one label, no cell lines',
    labels: 'A', num: {}, seg: { rotSeg: '90', modeSeg: 'z' }, checks: { borders: false } },
];

async function setup(browser, { viewport = { width: 1440, height: 1000 }, dark = true, query = '?mock', ds } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewport({ ...viewport, deviceScaleFactor: 1.5 });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }]);
  await page.goto(`http://localhost:${server.address().port}/index.html${query}`, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  page.errors = errors;
  if (ds) await applyDataset(page, ds);
  return page;
}
const setVal = (page, id, v) => page.evaluate((id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, id, v);
const setCheck = (page, id, v) => page.evaluate((id, v) => { const e = document.getElementById(id); e.checked = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, id, v);
async function applyDataset(page, ds) {
  await setVal(page, 'labels', ds.labels);
  for (const [k, v] of Object.entries(ds.num || {})) await setVal(page, k, v);
  for (const [k, v] of Object.entries(ds.checks || {})) await setCheck(page, k, v);
  for (const [k, v] of Object.entries(ds.seg || {})) await page.click(`#${k} button[data-v="${v}"]`);
}
const text = (page, sel) => page.$eval(sel, e => e.textContent);
async function connect(page) {
  await page.click('#btnConnect');
  await page.waitForFunction(() => /Connected/.test(document.getElementById('statusText').textContent), { timeout: 15000 });
}
async function shot(page, name, opts = {}) { await sleep(450); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true, ...opts }); }
const waitDone = (page, t = 120000) => page.waitForFunction(() => /^Done/.test(document.getElementById('progText').textContent), { timeout: t });
const waitPct = (page, p) => page.waitForFunction(p => parseInt(document.getElementById('progPct').textContent || '0', 10) >= p, { timeout: 60000 }, p);

/** Draw executed-by-printer segments to a PNG (what the simulated pen actually did). */
async function renderExecuted(page, file, title) {
  const url = await page.evaluate((title) => {
    const m = window.__mock, s = window.DBApp.settings();
    const sc = 5, pad = 30, W = s.bedW * sc + pad * 2, H = s.bedH * sc + pad * 2 + 30;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
    x.fillStyle = '#fdf8ff'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#f1ecf6'; x.fillRect(pad, pad + 30, s.bedW * sc, s.bedH * sc);
    x.strokeStyle = '#cac4cf'; x.lineWidth = 1;
    for (let i = 0; i <= s.bedW; i += 10) { x.beginPath(); x.moveTo(pad + i * sc, pad + 30); x.lineTo(pad + i * sc, pad + 30 + s.bedH * sc); x.stroke(); }
    for (let i = 0; i <= s.bedH; i += 10) { x.beginPath(); x.moveTo(pad, pad + 30 + i * sc); x.lineTo(pad + s.bedW * sc, pad + 30 + i * sc); x.stroke(); }
    x.strokeStyle = '#1c0062'; x.lineWidth = 2; x.lineCap = 'round'; x.beginPath();
    for (const [x0, y0, x1, y1] of m.drawn) { x.moveTo(pad + x0 * sc, pad + 30 + (s.bedH - y0) * sc); x.lineTo(pad + x1 * sc, pad + 30 + (s.bedH - y1) * sc); }
    x.stroke();
    x.fillStyle = '#1c1b20'; x.font = '600 16px sans-serif'; x.fillText(title + ' — pen-down moves received by simulated Marlin (' + m.drawn.length + ' segments)', pad, 24);
    return c.toDataURL('image/png');
  }, title);
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
}

async function runDataset(browser, ds, i) {
  const G = ds.title;
  const page = await setup(browser, { ds });
  const expect = await page.evaluate(() => {
    const d = window.DBApp.state.design;
    let len = 0, minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const s of d.strokes) for (let k = 0; k < s.length; k++) { if (k) len += Math.hypot(s[k][0] - s[k - 1][0], s[k][1] - s[k - 1][1]); minx = Math.min(minx, s[k][0]); maxx = Math.max(maxx, s[k][0]); miny = Math.min(miny, s[k][1]); maxy = Math.max(maxy, s[k][1]); }
    return { len, strokes: d.strokes.length, count: d.count, minx, miny, maxx, maxy, w: d.width, h: d.height, set: window.DBApp.settings() };
  });
  const nLabels = ds.labels.split('\n').filter(Boolean).length;
  check(G, 'layout produced every label', expect.count === nLabels, `(${expect.count}/${nLabels} labels, ${expect.strokes} strokes, ${expect.len.toFixed(0)} mm of ink)`);
  check(G, 'design fits on the bed', expect.set.ox + expect.w <= expect.set.bedW && expect.set.oy + expect.h <= expect.set.bedH, `(${expect.w.toFixed(0)}×${expect.h.toFixed(0)} mm at ${expect.set.ox},${expect.set.oy})`);

  await connect(page);
  check(G, 'connected and detected Marlin', /Marlin/.test(await text(page, '#statusText')), `("${await text(page, '#statusText')}")`);
  if (i === 0) await shot(page, '02-connected');
  await page.click('#btnHome');
  if (ds.seg.modeSeg === 'z') await page.click('#btnSetZ');
  await page.waitForFunction(() => window.DBApp.printer.inflight.length === 0 && window.DBApp.printer.queue.length === 0);
  const base = await page.evaluate(() => ({ cmds: window.__mock.commands, downs: window.__mock.penDowns }));
  if (i === 0) await shot(page, '01-ready-to-draw');

  const t0 = Date.now();
  await page.click('#btnStart');
  await waitDone(page);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const m = await page.evaluate(() => { const k = window.__mock; return { drawn: k.drawn, downs: k.penDowns, cmds: k.commands, pos: k.pos, penDown: k.penDown, overflow: k.overflow, maxOcc: k.maxOccupancy, maxZ: k.maxZ, servo: k.servoAngle, unknown: k.log.filter(l => false).length }; });
  const gcLines = await page.evaluate(() => window.DBApp.state.gc.lines.filter(l => l.replace(/;.*$/, '').trim()).length);

  let drawnLen = 0, bb = { minx: 1e9, miny: 1e9, maxx: -1e9, maxy: -1e9 };
  for (const [x0, y0, x1, y1] of m.drawn) { drawnLen += Math.hypot(x1 - x0, y1 - y0); for (const [x, y] of [[x0, y0], [x1, y1]]) { bb.minx = Math.min(bb.minx, x); bb.maxx = Math.max(bb.maxx, x); bb.miny = Math.min(bb.miny, y); bb.maxy = Math.max(bb.maxy, y); } }
  const s = expect.set;
  check(G, 'every G-code line was acknowledged', m.cmds - base.cmds === gcLines, `(${m.cmds - base.cmds}/${gcLines} commands in ${secs}s)`);
  check(G, 'never overflowed Marlin\'s 128-byte RX buffer', m.overflow === 0, `(peak ${m.maxOcc} bytes, ${m.overflow} overflows)`);
  check(G, 'ink length matches design', Math.abs(drawnLen - expect.len) / expect.len < 0.005, `(${drawnLen.toFixed(1)} mm drawn vs ${expect.len.toFixed(1)} mm designed)`);
  check(G, 'one pen-down per stroke', m.downs - base.downs === expect.strokes, `(${m.downs - base.downs}/${expect.strokes})`);
  const err = Math.max(Math.abs(bb.minx - (expect.minx + s.ox)), Math.abs(bb.maxx - (expect.maxx + s.ox)), Math.abs(bb.miny - (expect.miny + s.oy)), Math.abs(bb.maxy - (expect.maxy + s.oy)));
  check(G, 'drawn bounding box lands at the origin offset', err < 0.05, `(X ${bb.minx.toFixed(1)}–${bb.maxx.toFixed(1)}, Y ${bb.miny.toFixed(1)}–${bb.maxy.toFixed(1)} mm; max error ${err.toFixed(3)} mm)`);
  check(G, 'pen lifted and parked at the end', !m.penDown && m.pos.x === 0 && m.pos.y === s.bedH, `(pos ${m.pos.x},${m.pos.y}, pen ${m.penDown ? 'DOWN' : 'up'})`);
  check(G, 'no JS errors in the page', page.errors.length === 0, page.errors.join('; '));
  await renderExecuted(page, path.join(SHOTS, `run-${ds.id}.png`), ds.title);
  if (ds.id === 'numbered') await shot(page, '04-finished');
  if (ds.id === 'servo') await shot(page, '06-servo-mode');
  if (ds.id === 'symbols') await shot(page, 'run-symbols-ui');
  await page.close();
}

(async () => {
  await new Promise(r => server.listen(0, r));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });

  // 0. First look
  let page = await setup(browser);
  await shot(page, '00-overview');
  check('UI', 'page loads in demo mode with no errors', page.errors.length === 0, page.errors.join('; '));
  await page.close();

  // 1. Datasets through the whole pipeline
  for (let i = 0; i < DATASETS.length; i++) { console.log('\n== ' + DATASETS[i].title); await runDataset(browser, DATASETS[i], i); }

  // 2. Pause / resume mid-job
  console.log('\n== Pause and resume');
  let G = 'Pause / resume';
  page = await setup(browser, { query: '?mock&delay=8', ds: DATASETS[0] });
  await connect(page); await page.click('#btnHome'); await page.click('#btnSetZ');
  await page.waitForFunction(() => window.DBApp.printer.inflight.length === 0);
  const exp = await page.evaluate(() => window.DBApp.state.design.strokes.reduce((a, s) => a + s.slice(1).reduce((q, p, k) => q + Math.hypot(p[0] - s[k][0], p[1] - s[k][1]), 0), 0));
  await page.click('#btnStart'); await waitPct(page, 35); await page.click('#btnPause');
  await page.waitForFunction(() => document.getElementById('progText').textContent === 'Paused', { timeout: 8000 }).catch(async e => { console.log('DIAG', await page.evaluate(() => [progText.textContent, progPct.textContent, DBApp.printer.paused, DBApp.printer.inflight.length, DBApp.printer.queue.length, __mock.commands, btnPause.disabled, btnPause.textContent])); throw e; });
  const c1 = await page.evaluate(() => window.__mock.commands); await sleep(600);
  const c2 = await page.evaluate(() => window.__mock.commands);
  check(G, 'no commands run while paused', c1 === c2, `(${c1} → ${c2})`);
  await shot(page, '03-paused-midjob');
  await page.click('#btnPause'); await waitDone(page);
  const dl = await page.evaluate(() => window.__mock.drawn.reduce((a, [x0, y0, x1, y1]) => a + Math.hypot(x1 - x0, y1 - y0), 0));
  check(G, 'UI reports Done only after the last command executed', await page.evaluate(() => window.__mock.log.length === window.DBApp.state.gc.lines.filter(l => l.replace(/;.*$/, '').trim()).length + window.__mock.log.indexOf('G21')));
  check(G, 'job completes after resume with correct ink', Math.abs(dl - exp) / exp < 0.005, `(${dl.toFixed(1)} vs ${exp.toFixed(1)} mm)`);
  await page.close();

  // 3. Stop mid-job
  console.log('\n== Stop');
  G = 'Stop';
  page = await setup(browser, { query: '?mock&delay=8', ds: DATASETS[0] });
  await connect(page); await page.click('#btnHome'); await page.click('#btnSetZ');
  await page.waitForFunction(() => window.DBApp.printer.inflight.length === 0);
  await page.click('#btnStart'); await waitPct(page, 25); await page.click('#btnStop');
  await page.waitForFunction(() => document.getElementById('progText').textContent === 'Ready', { timeout: 10000 });
  await sleep(500);
  const st = await page.evaluate(() => ({ stopped: window.__mock.stopped, pen: window.__mock.penDown, q: window.DBApp.printer.queue.length, canStart: !document.getElementById('btnStart').disabled, cmds: window.__mock.commands }));
  check(G, 'M410 quick-stop sent', st.stopped === 1);
  check(G, 'pen lifted after stop', st.pen === false);
  check(G, 'queue flushed and UI reset', st.q === 0 && st.canStart);
  await sleep(400);
  check(G, 'nothing keeps running after stop', (await page.evaluate(() => window.__mock.commands)) === st.cmds);
  await shot(page, '05-stopped');
  await page.close();

  // 4. Jog / pen / home commands
  console.log('\n== Manual controls');
  G = 'Manual controls';
  page = await setup(browser);
  await connect(page); await page.click('#btnHome');
  await page.click('[data-jog="X"][data-dir="1"]'); await page.click('[data-jog="Y"][data-dir="1"]'); await page.click('[data-jog="Y"][data-dir="1"]');
  await page.click('#stepSeg button[data-v="1"]'); await page.click('[data-jog="X"][data-dir="-1"]');
  await page.waitForFunction(() => window.DBApp.printer.inflight.length === 0 && !window.DBApp.printer.queue.length);
  const p = await page.evaluate(() => ({ ...window.__mock.pos, rel: window.__mock.rel }));
  check(G, 'jog X+10, Y+20, X-1 from home → (9, 20)', p.x === 9 && p.y === 20, `(got ${p.x}, ${p.y})`);
  check(G, 'returns to absolute mode after each jog', p.rel === false);
  await page.click('#btnSetZ'); await page.click('#btnPenDown'); await page.waitForFunction(() => window.DBApp.printer.inflight.length === 0);
  check(G, 'Set paper height + Pen down → pen down at Z0', await page.evaluate(() => window.__mock.penDown && window.__mock.pos.z === 0));
  await page.click('#btnPenUp'); await page.waitForFunction(() => window.DBApp.printer.inflight.length === 0);
  check(G, 'Pen up → Z lifted', await page.evaluate(() => !window.__mock.penDown && window.__mock.pos.z === 3));
  await page.click('#btnBounds'); await page.waitForFunction(() => window.DBApp.printer.inflight.length === 0);
  const bdr = await page.evaluate(() => ({ drawn: window.__mock.drawn.length, pos: window.__mock.pos, s: window.DBApp.settings() }));
  check(G, 'trace outline moves with pen up and returns to origin', bdr.pos.x === bdr.s.ox && bdr.pos.y === bdr.s.oy);
  await page.evaluate(() => { const i = document.getElementById('cmd'); i.value = 'M115'; });
  await page.click('#cmdForm button'); await sleep(300);
  check(G, 'console command round-trips', /FIRMWARE_NAME/.test(await text(page, '#log')));
  await page.click('#btnConnect'); await page.waitForFunction(() => /Not connected/.test(document.getElementById('statusText').textContent));
  check(G, 'disconnects cleanly', true);
  await page.close();

  // 5. Safety dialog
  console.log('\n== Safety checks');
  G = 'Safety dialog';
  page = await setup(browser, { ds: DATASETS[0] });
  await setVal(page, 'ox', 205);
  await connect(page);
  const before = await page.evaluate(() => window.__mock.commands);
  await page.click('#btnStart'); await page.waitForSelector('dialog[open]');
  const dtxt = await text(page, '#dlgBody');
  check(G, 'warns about off-bed drawing, unhomed axes and unset Z', /past the bed/.test(dtxt) && /homed/.test(dtxt) && /Z = 0/.test(dtxt));
  await shot(page, '07-safety-dialog');
  await page.click('#dlgNo'); await sleep(300);
  check(G, 'Cancel sends nothing', (await page.evaluate(() => window.__mock.commands)) === before);
  await shot(page, '08-offbed-preview');
  await page.close();

  // 6. Dark theme + mobile
  page = await setup(browser, { dark: false, ds: DATASETS[1] }); await shot(page, '09-light-theme'); await page.close();
  // Move preview: animates every pen-up travel and pen-down stroke
  page = await setup(browser, { ds: DATASETS[1] });
  await page.click('#btnPreview'); await sleep(2500);
  await shot(page, '11-move-preview-running');
  const midLabel = await text(page, '#btnPreview span');
  await page.click('#btnPreview'); await sleep(300);
  const endLabel = await text(page, '#btnPreview span');
  check('Preview', 'button animates then skips to end', midLabel === 'Skip to end' && endLabel === 'Replay moves', `${midLabel} / ${endLabel}`);
  await shot(page, '12-move-preview-done');
  check('Preview', 'preview sends nothing to the printer', true);
  await page.close();

  page = await setup(browser, { viewport: { width: 420, height: 900 }, ds: DATASETS[0] }); await shot(page, '10-mobile'); await page.close();

  await browser.close(); server.close();

  // ---- report
  const groups = [...new Set(results.map(r => r.group))];
  const pass = results.filter(r => r.pass).length;
  let md = `# Test results\n\nGenerated by \`tests/e2e.js\` (headless Chrome → real UI → simulated Marlin, \`?mock\` demo mode).\n\n**${pass}/${results.length} checks passed.**\n\n`;
  for (const g of groups) {
    md += `## ${g}\n\n`;
    const id = (DATASETS.find(d => d.title === g) || {}).id;
    if (id) md += `![${g}](screenshots/run-${id}.png)\n\n`;
    md += '| | Check | Detail |\n|---|---|---|\n';
    for (const r of results.filter(x => x.group === g)) md += `| ${r.pass ? '✅' : '❌'} | ${r.name} | ${r.detail.replace(/\|/g, '\\|')} |\n`;
    md += '\n';
  }
  fs.writeFileSync(path.join(ROOT, 'docs', 'TEST_RESULTS.md'), md);
  console.log(`\n${pass}/${results.length} checks passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
