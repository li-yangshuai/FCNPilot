module top(x0, x1, y0);
input x0, x1;
output y0;
wire ps1, ps2, ps3;
assign ps1 = x0 | x1;
assign ps2 = x0 & x1;
assign ps3 = ~ps2;
assign y0 = ps1 & ps3;
endmodule
