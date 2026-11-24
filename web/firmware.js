/* Firmware download: fetches the current stock Marlin Ender-3 config from GitHub, applies the Drawbot patch
   (same changes as firmware/apply_drawbot.py) and hands back a zip. Nothing is uploaded anywhere. */
(function (g) {
  const BASE = 'https://raw.githubusercontent.com/MarlinFirmware/Configurations/bugfix-2.1.x/config/examples/Creality/Ender-3/';
  const BOARDS = {
    CrealityV1: 'Creality 1.1.x (8-bit, Melzi)',
    CrealityV422: 'Creality 4.2.2 (32-bit)',
    CrealityV427: 'Creality 4.2.7 (32-bit)',
  };

  function patch(cfg, adv, { servo = true } = {}) {
    const report = [];
    const sub = (text, re, repl, name) => { const n = re.test(text); report.push((n ? 'ok   ' : 'MISS ') + name); return n ? text.replace(re, repl) : text; };
    let c = cfg, a = adv;
    c = sub(c, /^#define TEMP_SENSOR_0 .*$/m, '#define TEMP_SENSOR_0 0 // Drawbot: no hotend', 'TEMP_SENSOR_0 -> 0');
    c = sub(c, /^#define TEMP_SENSOR_BED .*$/m, '#define TEMP_SENSOR_BED 0 // Drawbot: no heated bed', 'TEMP_SENSOR_BED -> 0');
    c = sub(c, /^#define THERMAL_PROTECTION_HOTENDS.*$/m, '//#define THERMAL_PROTECTION_HOTENDS // Drawbot', 'THERMAL_PROTECTION_HOTENDS off');
    c = sub(c, /^#define THERMAL_PROTECTION_BED.*$/m, '//#define THERMAL_PROTECTION_BED // Drawbot', 'THERMAL_PROTECTION_BED off');
    c = sub(c, /^#define PREVENT_COLD_EXTRUSION/m, '//#define PREVENT_COLD_EXTRUSION // Drawbot', 'PREVENT_COLD_EXTRUSION off');
    c = sub(c, /^#define CUSTOM_MACHINE_NAME .*$/m, '#define CUSTOM_MACHINE_NAME "Drawbot"', 'machine name');
    c = sub(c, /^#define DEFAULT_MAX_FEEDRATE\s+\{.*\}/m, '#define DEFAULT_MAX_FEEDRATE          { 500, 500, 20, 25 }', 'max feedrate Z 5 -> 20 mm/s');
    c = sub(c, /^#define DEFAULT_MAX_ACCELERATION\s+\{.*\}/m, '#define DEFAULT_MAX_ACCELERATION      { 800, 800, 200, 5000 }', 'max accel XY 800, Z 200');
    c = sub(c, /^#define DEFAULT_ACCELERATION\s+\d+.*$/m, '#define DEFAULT_ACCELERATION          800    // X, Y, Z acceleration for printing moves', 'default accel');
    c = sub(c, /^#define DEFAULT_TRAVEL_ACCELERATION\s+\d+.*$/m, '#define DEFAULT_TRAVEL_ACCELERATION   1200   // X, Y, Z acceleration for travel (non printing) moves', 'travel accel');
    c = sub(c, /^\s*#define MIN_SOFTWARE_ENDSTOP_Z\b.*$/m, '  //#define MIN_SOFTWARE_ENDSTOP_Z // Drawbot: pen height set with G92 Z0', 'Z min soft endstop off');
    if (servo) {
      c = sub(c, /^\/\/#define NUM_SERVOS 3.*$/m, '#define NUM_SERVOS 1 // Drawbot: pen-lift servo is M280 P0', 'NUM_SERVOS 1');
      c = sub(c, /^#define SERVO_DELAY \{.*\}/m, '#define SERVO_DELAY { 150 }', 'SERVO_DELAY 150');
      const board = c.match(/^\s*#define MOTHERBOARD (\w+)/m);
      if (board && board[1] === 'BOARD_MELZI_CREALITY' && !c.includes('SERVO0_PIN')) {
        c = c.replace('#define NUM_SERVOS 1', '#define SERVO0_PIN 27 // Drawbot: BLTouch header signal pin on 1.1.x board\n#define NUM_SERVOS 1');
        report.push('ok   SERVO0_PIN 27 (1.1.x board)');
      }
    }
    a = sub(a, /^\/\/#define EMERGENCY_PARSER/m, '#define EMERGENCY_PARSER // Drawbot: M410 quick-stop', 'EMERGENCY_PARSER on');
    return { cfg: c, adv: a, report };
  }

  // ---- minimal store-only zip ----
  const crcT = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = u8 => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcT[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function zip(files) {                           // files: [{name, data: string}]
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    const d = new Date(), dt = ((d.getFullYear() - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate()) & 0xFFFF, tm = (d.getHours() << 11 | d.getMinutes() << 5 | d.getSeconds() >> 1) & 0xFFFF;
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, tm, true); lh.setUint16(12, dt, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(12, tm, true); ch.setUint16(14, dt, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + data.length;
    }
    const csize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  async function fetchText(url) { const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(`GitHub returned ${r.status} for ${url.split('/').slice(-2).join('/')}`); return r.text(); }

  /** Downloads the stock configs for `board`, patches them, returns {blob, report, filename}. */
  async function build(board, servo) {
    const [c, a, bs, ss] = await Promise.all(['Configuration.h', 'Configuration_adv.h', '_Bootscreen.h', '_Statusscreen.h'].map(n => fetchText(BASE + board + '/' + n)));
    const p = patch(c, a, { servo });
    const readme = `Drawbot firmware (${BOARDS[board] || board}${servo ? ', servo pen lift' : ', Z-axis pen lift'})
Generated ${new Date().toISOString().slice(0, 10)} from the current MarlinFirmware/Configurations bugfix-2.1.x stock Ender-3 config.

Changes made (also see https://github.com/douggreenak/drawbot):
${p.report.map(l => '  ' + l).join('\n')}

To build and flash:
 1. Get Marlin 2.1.x: https://github.com/MarlinFirmware/Marlin (branch bugfix-2.1.x)
 2. Copy the four Marlin/*.h files from this zip over the ones in Marlin/Marlin/
 3. Open the Marlin folder in VS Code with PlatformIO, pick the env for your board (melzi for 1.1.x, STM32F103RET6_creality for 4.2.x), Build, then Upload (or copy the .bin to an SD card for 4.2.x boards).
 4. Not compiled or tested on hardware by this tool - check the build output.
 5. On 4.2.x boards, if the build complains about a missing sensor, set TEMP_SENSOR_0 to 998.
`;
    const blob = zip([{ name: 'Marlin/Configuration.h', data: p.cfg }, { name: 'Marlin/Configuration_adv.h', data: p.adv }, { name: 'Marlin/_Bootscreen.h', data: bs }, { name: 'Marlin/_Statusscreen.h', data: ss }, { name: 'README.txt', data: readme }]);
    return { blob, report: p.report, filename: `drawbot-firmware-${board}${servo ? '-servo' : ''}.zip` };
  }

  g.DBFirmware = { BOARDS, patch, zip, build };
})(typeof window !== 'undefined' ? window : globalThis);
