module top(x, y, z, H, I);
input x, y, z;
output H, I;
wire A, B, D, E, F, ifcn_tmp_0, ifcn_tmp_1;
assign A = y | z;
assign B = y & z;
assign ifcn_tmp_0 = ~B;
assign D = A & ifcn_tmp_0;
assign E = x | D;
assign F = x & D;
assign ifcn_tmp_1 = ~F;
assign H = E & ifcn_tmp_1;
assign I = B | F;
endmodule
