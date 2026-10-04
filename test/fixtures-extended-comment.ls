/PROG  TEST
/ATTR
OWNER		= MNEDITOR;
COMMENT		= "";
PROG_SIZE	= 918;
CREATE		= DATE 26-04-22  TIME 12:42:14;
MODIFIED	= DATE 26-09-15  TIME 17:40:14;
FILE_NAME	= ;
VERSION		= 0;
LINE_COUNT	= 8;
MEMORY_SIZE	= 1258;
PROTECT		= READ_WRITE;
TCD:  STACK_SIZE	= 0,
      TASK_PRIORITY	= 50,
      TIME_SLICE	= 0,
      BUSY_LAMP_OFF	= 0,
      ABORT_REQUEST	= 0,
      PAUSE_REQUEST	= 0;
DEFAULT_GROUP	= 1,*,*,*,*;
CONTROL_CODE	= 00000000 00000000;
LOCAL_REGISTERS	= 0,0,0;
/APPL
  HANDLING : TRUE ; 

AUTO_SINGULARITY_HEADER;
  ENABLE_SINGULARITY_AVOIDANCE   : FALSE;

  AUTOZONE_INTERFERENCE_AVOID;
    AUTOZONE_ENABLED         : FALSE;
    AUTOZONE_SCHEDULE_NUMBER : 1;
  CYCLE_REFERENCE = 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0;
  CYCLE_TARGET =   0.00 ;
/MN
   1:  --eg:s the test
    :  ddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd ;
   2:   ;
   3:  !Test Drop Pounce Pos ;
   4:J P[1] 100% FINE    ;
   5:   ;
   6:J PR[2:Pick Pnce/Home 2] 100% FINE    ;
   7:   ;
   8:J PR[7:Drop Pnce/Home 4] 100% FINE    ;
/POS
P[1]{
   GP1:
	UF : 1, UT : 1,	
	J1=     -.000 deg,	J2=   -26.072 deg,	J3=    20.059 deg,
	J4=     -.000 deg,	J5=   -86.719 deg,	J6=     -.000 deg
};
/END
