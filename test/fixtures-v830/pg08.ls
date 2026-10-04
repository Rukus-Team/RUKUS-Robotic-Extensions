/PROG  PG08
/ATTR
OWNER		= MNEDITOR;
COMMENT		= "Maintenance PRG";
PROG_SIZE	= 2088;
CREATE		= DATE 09-10-02  TIME 10:57:02;
MODIFIED	= DATE 14-08-04  TIME 15:41:02;
FILE_NAME	= ;
VERSION		= 0;
LINE_COUNT	= 83;
MEMORY_SIZE	= 2516;
PROTECT		= READ_WRITE;
TCD:  STACK_SIZE	= 0,
      TASK_PRIORITY	= 50,
      TIME_SLICE	= 0,
      BUSY_LAMP_OFF	= 0,
      ABORT_REQUEST	= 0,
      PAUSE_REQUEST	= 0;
DEFAULT_GROUP	= 1,*,*,*,*;
CONTROL_CODE	= 00000000 00000000;
/APPL
  SPOT Welding Equipment Number : 1 ;
  CYCLE_REFERENCE = 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0;
  CYCLE_TARGET =   0.00 ;
/MN
   1:  !***************************** ;
   2:  ! Manual Tip Dress ;
   3:  ! ;
   4:  ! Moves robot to Maint Position ;
   5:  ! ;
   6:  ! NOTE: This program has ;
   7:  !       GP[1:robot] and ;
   8:  ! ;
   9:  !***************************** ;
  10:   ;
  11:  !IF FFRActive(FastFaultRecovery) ;
  12:  !  Bit is ON, skip tp logic ;
  13:  IF DO[1015:OFF:FASTFAULTRECOV]=ON,JMP LBL[444] ;
  14:   ;
  15:  !Verify Program ;
  16:  PROGRAM VERIFY(8) ;
  17:   ;
  18:  !CLR TO ADV. TRANSFER ;
  19:  DO[954:ON :CLRTOADVXFR]=ON ;
  20:   ;
  21:  !Set Robot Payload WITHOUT PART ;
  22:  PAYLOAD[2] ;
  23:   ;
  24:  !Set Robot UTOOL Number ;
  25:  UTOOL_NUM=1 ;
  26:   ;
  27:  !Set Robot UFRAME Number ;
  28:  UFRAME_NUM=1 ;
  29:   ;
  30:  !Setup App Specific Outputs ;
  31:  !  Runs HOME_IO ;
  32:  SETUP OUTPUTS    ;
  33:   ;
  34:  !Move to Home ;
  35:  GO TO HOME POS    ;
  36:   ;
  37:   ;
  38:  LBL[444:FFRActive] ;
  39:   ;
  40:  !------------------------------ ;
  41:  !Approach to Maint Pos ;
  42:J P[1] 20% CNT100    ;
  43:J P[2] 20% CNT100    ;
  44:   ;
  45:  !Maintenance Position ;
  46:L P[3] 200mm/sec CNT100    ;
  47:   ;
  48:  !Maint Position ON ;
  49:  DO[6:OFF:RBT AT MAINT]=ON ;
  50:   ;
  51:  !IF FFRActive(FastFaultRecovery) ;
  52:  !  Bit is OFF, skip to logic ;
  53:  IF DO[1015:OFF:FASTFAULTRECOV]=OFF,JMP LBL[555] ;
  54:   ;
  55:  UALM[70] ;
  56:  WAIT DI[1024:OFF:STUDOUTMAINT]=ON    ;
  57:   ;
  58:  LBL[555] ;
  59:   ;
  60:  ! Turn ON Robot in LOOP ;
  61:  DO[24:OFF:RBT IN LOOP]=ON ;
  62:   ;
  63:  !Wait for Maintenance Clear ;
  64:  WAIT DI[7:OFF:MAINT POS CLR]=ON    ;
  65:   ;
  66:  ! Turn OFF Robot in LOOP ;
  67:  DO[24:OFF:RBT IN LOOP]=OFF ;
  68:   ;
  69:   ;
  70:   ;
  71:  !------------------------------ ;
  72:  !Depart from Maint Pos ;
  73:J P[2] 20% CNT100    ;
  74:J P[1] 20% CNT100    ;
  75:   ;
  76:  !Maint Position OFF ;
  77:  DO[6:OFF:RBT AT MAINT]=OFF ;
  78:   ;
  79:   ;
  80:  !Move to Home ;
  81:  GO TO HOME POS    ;
  82:   ;
  83:   ;
/POS
P[1]{
   GP1:
	UF : F, UT : F,		CONFIG : 'N D B, 0, 0, 0',
	X = ********  mm,	Y = ********  mm,	Z = ********  mm,
	W = ******** deg,	P = ******** deg,	R = ******** deg
};
P[2]{
   GP1:
	UF : F, UT : F,		CONFIG : 'N D B, 0, 0, 0',
	X = ********  mm,	Y = ********  mm,	Z = ********  mm,
	W = ******** deg,	P = ******** deg,	R = ******** deg
};
P[3]{
   GP1:
	UF : F, UT : F,		CONFIG : 'N D B, 0, 0, 0',
	X = ********  mm,	Y = ********  mm,	Z = ********  mm,
	W = ******** deg,	P = ******** deg,	R = ******** deg
};
/END
