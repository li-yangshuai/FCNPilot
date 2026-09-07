module top(x0, x1, x2, y0);
input x0, x1, x2;
output y0;
wire ps1, ps2, ps3, ps4, ps5, ps6, ps7;
assign ps1 = x0 | x1;
assign ps2 = x0 & x1;
assign ps3 = ~ps2;
assign ps4 = ps1 & ps3;
assign ps5 = ps4 | x2;
assign ps6 = ps4 & x2;
assign ps7 = ~ps6;
assign y0 = ps5 & ps7;
endmodule
