module top(x0, x1, x2, x3, x4, z0);
input x0, x1, x2, x3, x4;
output z0;
assign z0 = (((x0 ^ x1) ^ (x2 ^ x3)) ^ x4);
endmodule
