/* Label layout: text -> strokes in sheet millimetres (origin bottom-left, y up). */
(function (g) {
  const { glyphs: F, SPACE, GAP, CAP } = g.DBFont;

  function glyphFor(ch) {
    if (F[ch]) return F[ch];
    const up = ch.toUpperCase();
    return F[up] || F['?'];
  }

  /** Strokes for one line of text at cap height h, left edge at x=0, baseline y=0. */
  function lineStrokes(text, h) {
    const u = h / CAP;
    let x = 0;
    const out = [];
    for (const ch of Array.from(text)) {
      if (ch === ' ') { x += SPACE; continue; }
      const gl = glyphFor(ch);
      for (const s of gl.s) out.push(s.map(p => [(x + p[0]) * u, p[1] * u]));
      x += gl.w + GAP;
    }
    return { strokes: out, width: Math.max(0, x - GAP) * u };
  }

  /** One label per line. "A|B" = two text lines, trailing "@7.5" = custom cell width (mm). */
  function parseLabels(src, defaultW) {
    return src.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
      let w = defaultW;
      const m = l.match(/@\s*(\d+(?:\.\d+)?)\s*$/);
      if (m) { w = parseFloat(m[1]); l = l.slice(0, m.index).trim(); }
      return { lines: l ? l.split('|').map(s => s.trim()) : [], w };
    });
  }

  function fitLabel(cell, o) {
    // Frame in which text reads left->right. rot 0: cell W x H. rot +/-90: along cell height.
    const vertical = o.rot !== 0;
    const L = (vertical ? o.cellH : cell.w) - 2 * o.pad;      // available reading length
    const T = (vertical ? cell.w : o.cellH) - 2 * o.pad;      // available thickness
    const n = cell.lines.length;
    if (!n || L <= 0 || T <= 0) return [];
    const stack = n + (n - 1) * o.lineGap;
    let h = Math.min(o.textH, T / stack);
    const measure = hh => Math.max(...cell.lines.map(t => lineStrokes(t, hh).width));
    const w = measure(h);
    if (o.shrink && w > L) h = h * (L / w);
    const gap = h * o.lineGap;
    const out = [];
    cell.lines.forEach((t, k) => {
      const ls = lineStrokes(t, h);
      const vc = ((n - 1) / 2 - k) * (h + gap);
      for (const s of ls.strokes) {
        out.push(s.map(([px, py]) => {
          const u = px - ls.width / 2, v = py - h / 2 + vc;
          if (o.rot === 0) return [u, v];
          if (o.rot === 90) return [-v, u];
          return [v, -u];
        }));
      }
    });
    return out;
  }

  function layout(src, o) {
    const cells = parseLabels(src, o.cellW);
    const rows = [];
    let row = [], x = 0;
    for (const c of cells) {
      if (row.length && x + c.w > o.rowLen + 1e-6) { rows.push(row); row = []; x = 0; }
      row.push({ cell: c, x, w: c.w });
      x += c.w;
    }
    if (row.length) rows.push(row);

    const totalW = rows.reduce((m, r) => Math.max(m, r.length ? r[r.length - 1].x + r[r.length - 1].w : 0), 0);
    const totalH = rows.length ? rows.length * o.cellH + (rows.length - 1) * o.rowGap : 0;
    let strokes = [];

    rows.forEach((r, ri) => {
      const y0 = totalH - (ri + 1) * o.cellH - ri * o.rowGap;
      const rowW = r[r.length - 1].x + r[r.length - 1].w;
      for (const item of r) {
        const cx = item.x + item.w / 2, cy = y0 + o.cellH / 2;
        for (const s of fitLabel(item.cell, o)) strokes.push(s.map(([a, b]) => [cx + a, cy + b]));
      }
      if (o.borders) {
        strokes.push([[0, y0], [rowW, y0]]);
        strokes.push([[0, y0 + o.cellH], [rowW, y0 + o.cellH]]);
        strokes.push([[0, y0], [0, y0 + o.cellH]]);
        for (const item of r) strokes.push([[item.x + item.w, y0], [item.x + item.w, y0 + o.cellH]]);
      }
    });
    strokes = optimize(strokes);
    return { strokes, width: totalW, height: totalH, count: cells.length };
  }

  // ---- Path clean-up ---------------------------------------------------------
  function distSeg(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    let idx = 0, dmax = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = distSeg(pts[i], pts[0], pts[pts.length - 1]);
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
    return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
  }

  /** Simplify strokes, then order them (and flip direction) by nearest-neighbour to cut travel. */
  function optimize(strokes) {
    let list = strokes.map(s => {
      const d = [s[0]];
      for (let i = 1; i < s.length; i++) if (Math.hypot(s[i][0] - d[d.length - 1][0], s[i][1] - d[d.length - 1][1]) > 0.01) d.push(s[i]);
      return d.length > 1 ? rdp(d, 0.02) : d;
    }).filter(s => s.length > 1);

    const out = [];
    let cur = [0, 0];
    const used = new Uint8Array(list.length);
    for (let n = 0; n < list.length; n++) {
      let best = -1, bd = Infinity, rev = false;
      for (let i = 0; i < list.length; i++) {
        if (used[i]) continue;
        const s = list[i];
        const d1 = (s[0][0] - cur[0]) ** 2 + (s[0][1] - cur[1]) ** 2;
        const e = s[s.length - 1];
        const d2 = (e[0] - cur[0]) ** 2 + (e[1] - cur[1]) ** 2;
        if (d1 < bd) { bd = d1; best = i; rev = false; }
        if (d2 < bd) { bd = d2; best = i; rev = true; }
      }
      used[best] = 1;
      const s = rev ? list[best].slice().reverse() : list[best];
      out.push(s);
      cur = s[s.length - 1];
    }
    return out;
  }

  g.DBLayout = { layout, lineStrokes, parseLabels };
})(window);
