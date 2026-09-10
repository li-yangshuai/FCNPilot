module top(x0, x1, y0);
input x0, x1;
output y0;
wire n3, n4, n5, ifcn_tmp_0, ifcn_tmp_1, ifcn_tmp_2, ifcn_tmp_3, ifcn_tmp_4, ifcn_tmp_5, ifcn_tmp_6;
assign n3 = x0 | x1;
assign ifcn_tmp_0 = x0 & x1;
assign ifcn_tmp_1 = ~n3;
assign ifcn_tmp_2 = x0 & ifcn_tmp_1;
assign ifcn_tmp_3 = ifcn_tmp_0 | ifcn_tmp_2;
assign ifcn_tmp_4 = ~n3;
assign ifcn_tmp_5 = x1 & ifcn_tmp_4;
assign n4 = ifcn_tmp_3 | ifcn_tmp_5;
assign ifcn_tmp_6 = ~n4;
assign n5 = n3 & ifcn_tmp_6;
assign y0 = ~n5;
endmodule
