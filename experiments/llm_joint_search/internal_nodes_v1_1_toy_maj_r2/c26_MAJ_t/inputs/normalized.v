module top(x0, x1, x2, x3, x4, y0, y1);
input x0, x1, x2, x3, x4;
output y0, y1;
wire n6, n7, n8, n9, n10, ifcn_tmp_0, ifcn_tmp_1, ifcn_tmp_2, ifcn_tmp_3, ifcn_tmp_4, ifcn_tmp_5, ifcn_tmp_6;
assign n6 = x2 & x3;
assign n8 = x0 & x2;
assign ifcn_tmp_0 = ~n6;
assign n7 = x1 & ifcn_tmp_0;
assign n9 = n7 | n8;
assign ifcn_tmp_1 = ~n6;
assign ifcn_tmp_2 = x4 & ifcn_tmp_1;
assign ifcn_tmp_3 = x4 & n7;
assign ifcn_tmp_4 = ifcn_tmp_2 | ifcn_tmp_3;
assign ifcn_tmp_5 = ~n6;
assign ifcn_tmp_6 = ifcn_tmp_5 & n7;
assign n10 = ifcn_tmp_4 | ifcn_tmp_6;
assign y0 = n9;
assign y1 = n10;
endmodule
