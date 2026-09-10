module combo(a,b,c,y);
input a,b,c;
output y;
wire n;
assign n=a&b;
assign y=n|c;
endmodule
