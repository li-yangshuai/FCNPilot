module top(x, y, z, carry);
input x, y, z;
output carry;
wire or_yz, and_yz, xor_yz, and_x, ifcn_tmp_0;
assign or_yz = y | z;
assign and_yz = y & z;
assign ifcn_tmp_0 = ~and_yz;
assign xor_yz = or_yz & ifcn_tmp_0;
assign and_x = x & xor_yz;
assign carry = and_yz | and_x;
endmodule
