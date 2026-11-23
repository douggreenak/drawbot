; Drawbot pen test - Z-axis lift. 20 mm square.
; Before printing: jog the pen by hand to the lower-left corner of the test spot, pen just touching the paper.
; This file treats that spot as 0,0,0 (G92). Nothing homes.
G21
G90
G92 X0 Y0 Z0
G0 Z3 F600
G0 X0 Y0 F3000
G1 Z0 F600
G1 X20 Y0 F1500
G1 X20 Y20
G1 X0 Y20
G1 X0 Y0
G0 Z3 F600
G0 X0 Y0 F3000
M84
