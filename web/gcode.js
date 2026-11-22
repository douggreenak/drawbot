/* G-code generation for Marlin. Coordinates: sheet mm + origin offset = bed mm. */
(function (g) {
  const f = v => {
    const s = (Math.round(v * 100) / 100).toFixed(2);
    return s.replace(/\.?0+$/, '') || '0';
  };

  function penUp(s) {
    return s.penMode === 'servo'
      ? ['M400', `M280 P0 S${f(s.svUp)}`, `G4 P${Math.round(s.svDelay)}`]
      : [`G0 Z${f(s.zUp)} F${f(s.zFeed)}`];
  }
  function penDown(s) {
    return s.penMode === 'servo'
      ? ['M400', `M280 P0 S${f(s.svDown)}`, `G4 P${Math.round(s.svDelay)}`]
      : [`G1 Z${f(s.zDown)} F${f(s.zFeed)}`];
  }

  /** Returns { lines, strokeOf } where strokeOf[i] is the stroke index a line belongs to (-1 = setup). */
  function build(strokes, s) {
    const lines = [], strokeOf = [];
    const add = (l, k) => { lines.push(l); strokeOf.push(k); };
    add('; Drawbot label job', -1);
    add('G21', -1);
    add('G90', -1);
    penUp(s).forEach(l => add(l, -1));
    let feed = null;
    const move = (cmd, x, y, F, k) => {
      let l = `${cmd} X${f(x + s.ox)} Y${f(y + s.oy)}`;
      if (F !== feed) { l += ` F${f(F)}`; feed = F; }
      add(l, k);
    };
    strokes.forEach((st, k) => {
      move('G0', st[0][0], st[0][1], s.travelFeed, k);
      penDown(s).forEach(l => add(l, k));
      feed = null; // the pen-down move may have changed the modal feedrate
      for (let i = 1; i < st.length; i++) move('G1', st[i][0], st[i][1], s.drawFeed, k);
      penUp(s).forEach(l => add(l, k));
      feed = null;
    });
    add(`G0 X${f(s.parkX)} Y${f(s.parkY)} F${f(s.travelFeed)}`, -1);
    add('M400', -1);
    add('; done', -1);
    return { lines, strokeOf };
  }

  function stats(strokes, s) {
    let draw = 0, travel = 0, cur = [-s.ox, -s.oy];
    for (const st of strokes) {
      travel += Math.hypot(st[0][0] - cur[0], st[0][1] - cur[1]);
      for (let i = 1; i < st.length; i++) draw += Math.hypot(st[i][0] - st[i - 1][0], st[i][1] - st[i - 1][1]);
      cur = st[st.length - 1];
    }
    const lift = s.penMode === 'servo'
      ? 2 * (s.svDelay / 1000 + 0.05)
      : 2 * (Math.abs(s.zUp - s.zDown) / (s.zFeed / 60)) + 0.1;
    const seconds = (draw / (s.drawFeed / 60)) * 1.35 + travel / (s.travelFeed / 60) * 1.2 + strokes.length * lift;
    return { draw, travel, seconds, strokes: strokes.length };
  }

  g.DBGcode = { build, stats, penUp, penDown, f };
})(window);
