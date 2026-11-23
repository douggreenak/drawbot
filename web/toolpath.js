/* Toolpath simulation: replays the generated G-code (from the pen's zero point) and reports anything unsafe. */
(function (g) {
  /**
   * lines: G-code lines. s: settings (penMode, zDown, zUp, svUp, svDown, bedW, bedH) + zx, zy = where the zero point sits on the bed (mm).
   * card: optional {x,y,w,h} frame rectangle in work coordinates; ink outside it is flagged.
   */
  function simulate(lines, s, card) {
    const zx = s.zx || 0, zy = s.zy || 0, tol = 0.01;
    let x = 0, y = 0, z = 0, rel = false, servo = null;
    const segs = [], bad = {};
    const issue = (key, level, text, at) => { const b = bad[key] || (bad[key] = { level, text, at, count: 0 }); b.count++; };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, zmin = 0, zmax = 0, drawLen = 0, travelLen = 0, moves = 0;
    const isDown = () => s.penMode === 'servo' ? (servo !== null && Math.abs(servo - s.svDown) < Math.abs(servo - s.svUp)) : z <= s.zDown + 0.05;
    const grow = (px, py) => { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); };
    grow(0, 0);
    for (const raw of lines) {
      const l = raw.replace(/;.*$/, '').trim(); if (!l) continue;
      const w = l.split(/\s+/), cmd = w[0].toUpperCase();
      const val = a => { const t = w.find(q => q[0].toUpperCase() === a); return t ? parseFloat(t.slice(1)) : undefined; };
      if (cmd === 'G90') rel = false; else if (cmd === 'G91') rel = true;
      else if (cmd === 'M280') servo = val('S');
      else if (cmd === 'G0' || cmd === 'G1') {
        const nx = val('X'), ny = val('Y'), nz = val('Z');
        const X = nx === undefined ? x : rel ? x + nx : nx, Y = ny === undefined ? y : rel ? y + ny : ny, Z = nz === undefined ? z : rel ? z + nz : nz;
        const xy = Math.hypot(X - x, Y - y), dz = Math.abs(Z - z);
        if (xy > 1e-6 || dz > 1e-6) {
          moves++;
          const wasDown = isDown(), seg = { x0: x, y0: y, z0: z, x1: X, y1: Y, z1: Z, kind: xy > 1e-6 ? (wasDown && isDown2(Z) ? 'draw' : 'travel') : 'z', bad: false };
          function isDown2(zz) { return s.penMode === 'servo' ? wasDown : zz <= s.zDown + 0.05; }
          seg.down = seg.kind === 'draw';
          if (seg.kind === 'draw') drawLen += xy; else if (seg.kind === 'travel') travelLen += xy;
          const mx = X + zx, my = Y + zy;
          if (mx < -tol || mx > s.bedW + tol || my < -tol || my > s.bedH + tol) { seg.bad = true; issue('bed', 'error', `Moves outside the bed (${s.bedW} × ${s.bedH} mm)`, [X, Y]); }
          if (seg.kind === 'draw' && cmd === 'G0') { seg.bad = true; issue('rapid', 'error', 'Rapid (G0) move with the pen down', [X, Y]); }
          if (s.penMode !== 'servo' && Z < -0.05) { seg.bad = true; issue('zlow', 'error', 'Z goes below the paper surface (Z < 0) and would push into the bed', [X, Y]); }
          if (seg.kind === 'draw' && card && (X < card.x - 0.5 || X > card.x + card.w + 0.5 || Y < card.y - 0.5 || Y > card.y + card.h + 0.5)) { seg.bad = true; issue('card', 'warn', 'Ink lands outside the card', [X, Y]); }
          segs.push(seg); x = X; y = Y; z = Z; grow(x, y); zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
        }
      }
    }
    if (s.penMode !== 'servo' && s.zDown > 0.3) issue('zhigh', 'warn', `Pen-down Z is ${s.zDown} mm: the pen may not reach the paper`, null);
    const issues = Object.values(bad);
    return { segs, issues, errors: issues.filter(i => i.level === 'error').length, bbox: { minX, maxX, minY, maxY }, zmin, zmax, drawLen, travelLen, moves };
  }
  g.DBPath = { simulate };
})(window);
