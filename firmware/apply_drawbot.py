#!/usr/bin/env python3
"""
Turn a stock Marlin 2.1.x Ender-3 configuration into a Drawbot configuration.

Usage:
    python3 apply_drawbot.py /path/to/Marlin            # patches in place (makes .orig backups)
    python3 apply_drawbot.py /path/to/Marlin --no-servo  # Z-axis pen lift only

Start from the matching example in
  https://github.com/MarlinFirmware/Configurations/tree/bugfix-2.1.x/config/examples/Creality/Ender-3
(CrealityV1 = 8-bit 1.1.x boards, CrealityV422 / V427 = 32-bit 4.2.x boards), copy its
Configuration.h + Configuration_adv.h into Marlin/Marlin/, then run this script.

What it changes (see README.md for the why):
  * heaters/thermistors off  -> the board will not halt with "MINTEMP" with no hotend fitted
  * thermal protection off
  * Z min software endstop off -> lets the UI set paper height with G92 Z0
  * Z feedrate/acceleration up -> fast pen lift when using the Z axis
  * EMERGENCY_PARSER on        -> M410 "Stop" button works instantly
  * optional servo pen lift on M280 P0
  * machine name "Drawbot"
"""
import re
import shutil
import sys
from pathlib import Path


def sub_once(text, pattern, repl, name, report):
    new, n = re.subn(pattern, repl, text, count=1, flags=re.M)
    report.append(("ok  " if n else "MISS") + " " + name)
    return new


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    use_servo = "--no-servo" not in sys.argv
    if not args:
        print(__doc__)
        sys.exit(1)
    root = Path(args[0])
    cfg = next(iter(root.glob("**/Configuration.h")), None) if not (root / "Marlin" / "Configuration.h").exists() else root / "Marlin" / "Configuration.h"
    if cfg is None or not cfg.exists():
        sys.exit("Could not find Configuration.h under " + str(root))
    adv = cfg.with_name("Configuration_adv.h")
    if not adv.exists():
        sys.exit("Configuration_adv.h not next to Configuration.h")

    for f in (cfg, adv):
        bak = f.with_suffix(f.suffix + ".orig")
        if not bak.exists():
            shutil.copy2(f, bak)

    r = []
    c = cfg.read_text()
    a = adv.read_text()

    # --- heaters / thermal -------------------------------------------------
    c = sub_once(c, r"^#define TEMP_SENSOR_0 .*$", "#define TEMP_SENSOR_0 0 // Drawbot: no hotend", "TEMP_SENSOR_0 -> 0", r)
    c = sub_once(c, r"^#define TEMP_SENSOR_BED .*$", "#define TEMP_SENSOR_BED 0 // Drawbot: no heated bed", "TEMP_SENSOR_BED -> 0", r)
    c = sub_once(c, r"^#define THERMAL_PROTECTION_HOTENDS.*$", "//#define THERMAL_PROTECTION_HOTENDS // Drawbot", "THERMAL_PROTECTION_HOTENDS off", r)
    c = sub_once(c, r"^#define THERMAL_PROTECTION_BED.*$", "//#define THERMAL_PROTECTION_BED // Drawbot", "THERMAL_PROTECTION_BED off", r)
    c = sub_once(c, r"^#define PREVENT_COLD_EXTRUSION", "//#define PREVENT_COLD_EXTRUSION // Drawbot", "PREVENT_COLD_EXTRUSION off", r)

    # --- identity ------------------------------------------------------------
    c = sub_once(c, r'^#define CUSTOM_MACHINE_NAME .*$', '#define CUSTOM_MACHINE_NAME "Drawbot"', "machine name", r)

    # --- motion ------------------------------------------------------------
    c = sub_once(c, r"^#define DEFAULT_MAX_FEEDRATE\s+\{.*\}", "#define DEFAULT_MAX_FEEDRATE          { 500, 500, 20, 25 }", "max feedrate Z 5 -> 20 mm/s", r)
    c = sub_once(c, r"^#define DEFAULT_MAX_ACCELERATION\s+\{.*\}", "#define DEFAULT_MAX_ACCELERATION      { 800, 800, 200, 5000 }", "max accel XY 800, Z 200", r)
    c = sub_once(c, r"^#define DEFAULT_ACCELERATION\s+\d+.*$", "#define DEFAULT_ACCELERATION          800    // X, Y, Z acceleration for printing moves", "default accel", r)
    c = sub_once(c, r"^#define DEFAULT_TRAVEL_ACCELERATION\s+\d+.*$", "#define DEFAULT_TRAVEL_ACCELERATION   1200   // X, Y, Z acceleration for travel (non printing) moves", "travel accel", r)
    # Pen height is set at runtime with G92 Z0 -> a Z-min software limit would block it.
    c = sub_once(c, r"^\s*#define MIN_SOFTWARE_ENDSTOP_Z\b.*$", "  //#define MIN_SOFTWARE_ENDSTOP_Z // Drawbot: pen height set with G92 Z0", "Z min soft endstop off", r)

    # --- servo pen lift ------------------------------------------------------
    if use_servo:
        c = sub_once(c, r"^//#define NUM_SERVOS 3.*$", "#define NUM_SERVOS 1 // Drawbot: pen-lift servo is M280 P0", "NUM_SERVOS 1", r)
        c = sub_once(c, r"^#define SERVO_DELAY \{.*\}", "#define SERVO_DELAY { 150 }", "SERVO_DELAY 150", r)
        board = re.search(r"^\s*#define MOTHERBOARD (\w+)", c, flags=re.M)
        if board and board.group(1) == "BOARD_MELZI_CREALITY":
            # The 8-bit board only maps SERVO0_PIN when BLTOUCH is on, so map it ourselves.
            if "SERVO0_PIN" not in c:
                c = c.replace("#define NUM_SERVOS 1", "#define SERVO0_PIN 27 // Drawbot: BLTouch header signal pin on 1.1.x board\n#define NUM_SERVOS 1", 1)
                r.append("ok   SERVO0_PIN 27 (1.1.x board)")
        else:
            r.append("info board " + (board.group(1) if board else "?") + " already maps SERVO0_PIN (BLTouch header)")

    # --- Configuration_adv.h ---------------------------------------------------
    a = sub_once(a, r"^//#define EMERGENCY_PARSER", "#define EMERGENCY_PARSER // Drawbot: M410 quick-stop", "EMERGENCY_PARSER on", r)

    cfg.write_text(c)
    adv.write_text(a)

    print("Patched", cfg, "and", adv.name)
    for line in r:
        print("  " + line)
    if any(x.startswith("MISS") for x in r):
        print("\nSome settings were not found - your Marlin version may differ. Check them by hand (see README).")
    print("\nBackups: *.orig next to each file. Build & flash with PlatformIO / VS Code (see README).")


if __name__ == "__main__":
    main()
