module top(x0, x1, x2, y0);
input x0, x1, x2;
output y0;
wire n4, ifcn_tmp_0, ifcn_tmp_1, ifcn_tmp_2, ifcn_tmp_3, ifcn_tmp_4, ifcn_tmp_5;
assign ifcn_tmp_0 = x0 & x1;
assign ifcn_tmp_1 = ~x2;
assign ifcn_tmp_2 = x0 & ifcn_tmp_1;
assign ifcn_tmp_3 = ifcn_tmp_0 | ifcn_tmp_2;
assign ifcn_tmp_4 = ~x2;
assign ifcn_tmp_5 = x1 & ifcn_tmp_4;
assign n4 = ifcn_tmp_3 | ifcn_tmp_5;
assign y0 = n4;
endmodule
