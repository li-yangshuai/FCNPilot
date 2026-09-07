module top(a, b, c, parity);
input a, b, c;
output parity;
wire ps1, ps2, ps3, ps4, ps5, ps6, ps7;
assign ps1 = a | b;
assign ps2 = a & b;
assign ps3 = ~ps2;
assign ps4 = ps1 & ps3;
assign ps5 = ps4 | c;
assign ps6 = ps4 & c;
assign ps7 = ~ps6;
assign parity = ps5 & ps7;
endmodule
