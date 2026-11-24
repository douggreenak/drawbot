/* Demo / test mode: add ?mock to the URL and a simulated Marlin printer replaces Web Serial.
   It models Marlin's 128-byte RX buffer, replies "ok" per command, tracks position and pen state,
   and records every pen-down segment so tests can compare what was "drawn" with what was designed. */
(function () {
  if (!/[?&]mock\b/.test(location.search)) return;
  const q = new URLSearchParams(location.search);
  const delay = parseFloat(q.get('delay') || '0');   // ms per command (0 = as fast as possible)
  const enc = new TextEncoder(), dec = new TextDecoder();
  const m = window.__mock = {
    pos: { x: 0, y: 0, z: 5 }, rel: false, feed: 0, penDown: false, servoAngle: null,
    drawn: [], penDowns: 0, occupancy: 0, maxOccupancy: 0, overflow: 0, commands: 0, log: [], maxZ: 5, minZ: 5, stopped: 0,
  };
  let ctrl = null, buf = '', busy = false;
  const queue = [];
  const reply = t => ctrl && ctrl.enqueue(enc.encode(t + '\n'));

  function setPen(down) { if (down && !m.penDown) m.penDowns++; m.penDown = down; }

  function exec(raw) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) return;
    const w = line.split(/\s+/), cmd = w[0].toUpperCase();
    if (cmd !== 'M114') { m.commands++; m.log.push(line); }   // M114 is the app's position poll; keep it out of the counters
    const val = a => { const t = w.find(x => x[0].toUpperCase() === a); return t ? parseFloat(t.slice(1)) : undefined; };
    if (cmd === 'G0' || cmd === 'G1') {
      const n = { x: m.pos.x, y: m.pos.y, z: m.pos.z };
      for (const a of ['x', 'y', 'z']) { const v = val(a.toUpperCase()); if (v !== undefined) n[a] = m.rel ? n[a] + v : v; }
      const f = val('F'); if (f) m.feed = f;
      if (n.z !== m.pos.z) { setPen(n.z <= 0.01); m.maxZ = Math.max(m.maxZ, n.z); m.minZ = Math.min(m.minZ, n.z); }
      if ((n.x !== m.pos.x || n.y !== m.pos.y) && m.penDown) m.drawn.push([m.pos.x, m.pos.y, n.x, n.y]);
      m.pos = n;
    } else if (cmd === 'G28') { if (w.length === 1 || w.includes('X')) m.pos.x = 0; if (w.length === 1 || w.includes('Y')) m.pos.y = 0; }
    else if (cmd === 'G90') m.rel = false;
    else if (cmd === 'G91') m.rel = true;
    else if (cmd === 'G92') { const x = val('X'), y = val('Y'), z = val('Z'); if (x !== undefined) m.pos.x = x; if (y !== undefined) m.pos.y = y; if (z !== undefined) { m.pos.z = z; setPen(z <= 0.01); } }
    else if (cmd === 'M280') { m.servoAngle = val('S'); setPen(m.servoAngle <= 60); }
    else if (cmd === 'M114') { reply(`X:${m.pos.x.toFixed(2)} Y:${m.pos.y.toFixed(2)} Z:${m.pos.z.toFixed(2)} E:0.00 Count X:0 Y:0 Z:0`); }
    else if (cmd === 'M502' || cmd === 'M500') { m.eepromReset = (m.eepromReset || 0) + 1; }
    else if (cmd === 'M410') { queue.length = 0; m.occupancy = 0; m.stopped++; }
    else if (cmd === 'M115') { reply('FIRMWARE_NAME:Marlin 2.1.2.5 (Drawbot mock) SOURCE_CODE_URL:github.com/MarlinFirmware/Marlin MACHINE_TYPE:' + (q.has('stock') ? 'Ender-3' : 'Drawbot')); }
    else if (!['G21', 'G4', 'M400', 'M84', 'M18', 'M500', 'M502'].includes(cmd)) { reply('echo:Unknown command: "' + line + '"'); }
  }

  function step() {
    const next = queue.shift();
    if (!next) { busy = false; return; }
    exec(next.line);
    m.occupancy -= next.len;
    reply('ok');
    if (delay > 0) setTimeout(step, delay); else queueMicrotask ? setTimeout(step, 0) : step();
  }
  // setTimeout(0) clamps to ~4ms after nesting, so use a MessageChannel for fast mode.
  if (delay === 0) {
    const ch = new MessageChannel();
    let cb = null; ch.port1.onmessage = () => cb && cb();
    const fast = f => { cb = f; ch.port2.postMessage(0); };
    window.__fast = fast;
  }
  function kick() {
    if (busy) return; busy = true;
    if (delay === 0) { const loop = () => { const next = queue.shift(); if (!next) { busy = false; return; } exec(next.line); m.occupancy -= next.len; reply('ok'); window.__fast(loop); }; window.__fast(loop); }
    else setTimeout(step, delay);
  }

  function onData(chunk) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r/g, ''); buf = buf.slice(i + 1);
      const len = line.length + 1;
      if (/^M410\b/.test(line)) { exec(line); continue; } // emergency parser: handled immediately
      m.occupancy += len; m.maxOccupancy = Math.max(m.maxOccupancy, m.occupancy);
      if (m.occupancy > 128) m.overflow++;                  // real Marlin would drop characters here
      queue.push({ line, len });
    }
    kick();
  }

  const port = {
    async open(o) {
      m.baud = o.baudRate;
      this.readable = new ReadableStream({ start(c) { ctrl = c; setTimeout(() => { reply('start\necho: Marlin 2.1.2.5 (mock)'); if (q.has('eeprom')) reply('echo:EEPROM version mismatch (EEPROM=V87 Firmware=V90)'); }, 50); } });
      this.writable = new WritableStream({ write: onData });
    },
    async close() { try { ctrl && ctrl.close(); } catch (e) { /* ignore */ } },
  };
  Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => { window.__granted = true; return port; }, getPorts: async () => (q.has('granted') || window.__granted) ? [port] : [], addEventListener() {} }, configurable: true });
  document.title += ' (demo mode)';
})();
