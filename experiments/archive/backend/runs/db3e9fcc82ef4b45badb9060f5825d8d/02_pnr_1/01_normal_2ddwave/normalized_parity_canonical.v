module top(x0, x1, x2, y0);
input x0, x1, x2;
output y0;
assign y0 = ((x0 ^ x1) ^ x2);
endmodule
