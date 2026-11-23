; Drawbot pen test - servo lift. 20 mm square.
; Before printing: move the pen by hand to the lower-left corner of the test spot.
; This file treats that spot as 0,0 (G92). Nothing homes. Angles: up 90, down 40 - adjust to your pen.
G21
G90
G92 X0 Y0
M280 P0 S90
G4 P300
G0 X0 Y0 F3000
M280 P0 S40
G4 P300
G1 X20 Y0 F1500
G1 X20 Y20
G1 X0 Y20
G1 X0 Y0
M280 P0 S90
G4 P300
M84
