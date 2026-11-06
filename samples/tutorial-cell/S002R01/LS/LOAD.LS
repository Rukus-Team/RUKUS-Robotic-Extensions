/PROG  LOAD
/ATTR
LINE_COUNT	= 4;
/MN
   1:  !Load a part and count it ;
   2:  J P[1] 100% FINE ;
   3:  R[5]=R[5]+1 ;
   4:  WAIT R[5]>=10 ;
/POS
P[1]{
   GP1:
	UF : 1, UT : 1,
	X =  100.000  mm,
	Y =  200.000  mm,
	Z =  300.000  mm,
	W =     0.000 deg,
	P =     0.000 deg,
	R =     0.000 deg
};
/END
