module top(pi0, pi1, pi2, pi3, pi4, po0, po1);
input pi0, pi1, pi2, pi3, pi4;
output po0, po1;
wire n9, n10, n11, n13, ifcn_tmp_0, ifcn_tmp_1, ifcn_tmp_2, ifcn_tmp_3, ifcn_tmp_4;
assign n9 = pi2 & pi3;
assign n11 = pi0 & pi2;
assign ifcn_tmp_0 = ~pi1;
assign ifcn_tmp_1 = ~pi4;
assign n13 = ifcn_tmp_0 & ifcn_tmp_1;
assign ifcn_tmp_2 = ~n9;
assign n10 = ifcn_tmp_2 & pi1;
assign ifcn_tmp_3 = ~n9;
assign ifcn_tmp_4 = ~n13;
assign po1 = ifcn_tmp_3 & ifcn_tmp_4;
assign po0 = n10 | n11;
endmodule
