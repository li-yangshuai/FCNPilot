module top(a, b, out);
input a, b;
output out;
wire ps1, ps2, ps3;
assign ps1 = a | b;
assign ps2 = a & b;
assign ps3 = ~ps2;
assign out = ps1 & ps3;
endmodule
