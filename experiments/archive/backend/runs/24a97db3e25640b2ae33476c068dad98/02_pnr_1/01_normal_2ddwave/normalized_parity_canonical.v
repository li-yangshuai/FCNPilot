module top(a, b, c, parity);
input a, b, c;
output parity;
assign parity = ((a ^ b) ^ c);
endmodule
