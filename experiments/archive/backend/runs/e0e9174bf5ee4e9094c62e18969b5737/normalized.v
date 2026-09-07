module top(pi0, pi1, pi2, po0, po1, po2, po3);
input pi0, pi1, pi2;
output po0, po1, po2, po3;
wire n8, n9, n11, n12, ifcn_tmp_0, ifcn_tmp_1, ifcn_tmp_2, ifcn_tmp_3, ifcn_tmp_4;
assign n8 = pi0 & pi1;
assign ifcn_tmp_0 = ~pi0;
assign ifcn_tmp_1 = ~pi1;
assign n9 = ifcn_tmp_0 & ifcn_tmp_1;
assign po3 = ~pi2;
assign po0 = pi2;
assign ifcn_tmp_2 = ~pi2;
assign n11 = ifcn_tmp_2 & n8;
assign ifcn_tmp_3 = ~n8;
assign ifcn_tmp_4 = ~n9;
assign po1 = ifcn_tmp_3 & ifcn_tmp_4;
assign n12 = pi2 & n9;
assign po2 = n11 | n12;
endmodule
