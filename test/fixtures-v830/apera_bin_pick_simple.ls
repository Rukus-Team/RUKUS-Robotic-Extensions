/PROG  APERA_BIN_PICK_SIMPLE
/ATTR
OWNER		= MNEDITOR;
COMMENT		= "Pick and Place";
PROG_SIZE	= 2006;
CREATE		= DATE 20-01-06  TIME 13:41:36;
MODIFIED	= DATE 26-02-26  TIME 16:15:44;
FILE_NAME	= T_PICKPL;
VERSION		= 0;
LINE_COUNT	= 73;
MEMORY_SIZE	= 2506;
PROTECT		= READ_WRITE;
TCD:  STACK_SIZE	= 1000,
      TASK_PRIORITY	= 50,
      TIME_SLICE	= 0,
      BUSY_LAMP_OFF	= 0,
      ABORT_REQUEST	= 0,
      PAUSE_REQUEST	= 0;
DEFAULT_GROUP	= 1,*,*,*,*;
CONTROL_CODE	= 00000000 00000000;
/APPL
  HANDLING : TRUE ; 
/MN
   1:  --eg: Before use, please set: ;
   2:  --eg: SR[1]: pipeline_id ;
   3:  --eg: R[100]: server_id (typically 1) ;
   4:  --eg: PR[15]: pounce position (out of FOV) ;
   5:  --eg: PR[16]: placement-pose ;
   6:   ;
   7:  --eg: The following are are also used ;
   8:  --eg: R[101] for status code ;
   9:  --eg: R[102] for found part ;
  10:  --eg: R[103] for pick point id ;
  11:  --eg: PR[2] above bin pose ;
  12:  --eg: PR[20] for current pose ;
  13:  --eg: PR[21] for vision pose ;
  14:  --eg: PR[17] for placement-transform ;
  15:  --eg: PR[18] for transformed placement-pose ;
  16:  --eg: and assume robot has 6 joints ;
  17:   ;
  18:  LBL[1:Start] ;
  19:  ! Clear status register ;
  20:  R[101:status code apea]=0    ;
  21:   ;
  22:  ! Move to pounce position ;
  23:J PR[15:Direct Ld 5] 100% FINE    ;
  24:   ;
  25:  !Get current pose ;
  26:  PR[20:ReservedTIPWR]=LPOS    ;
  27:  !Request Apera to locate parts ;
  28:  !Using SR[1] ;
  29:  CALL APERA_TRIGGR(4,R[100:Apera Server id],101) ;
  30:  CALL A_WAIT_CAP(6,R[100:Apera Server id],101) ;
  31:  !Get vision pose ;
  32:  CALL APERA_GETPOS(4,R[100:Apera Server id],101,102,103,21,20,17) ;
  33:   ;
  34:  !Check call status ;
  35:  IF R[101:status code apea]=0,JMP LBL[2] ;
  36:   ;
  37:  !Display error msg ;
  38:  MESSAGE[Error in locating parts] ;
  39:  JMP LBL[1] ;
  40:   ;
  41:  !Check found part ;
  42:  LBL[2:Check parts] ;
  43:   ;
  44:  !Try again if no pose found ;
  45:  IF R[102:found part]=0,JMP LBL[1] ;
  46:   ;
  47:  ! Move above bin ;
  48:J PR[2:Home 2] 100% FINE    ;
  49:   ;
  50:  !Goto vision pose ;
  51:J PR[21:ReservedTIPWR] 20% FINE    ;
  52:   ;
  53:  ! Move above bin ;
  54:J PR[2:Home 2] 100% FINE    ;
  55:   ;
  56:  ! Transform placement position ;
  57:  ! Assume placement position is in ;
  58:  ! Transform is in register 17. Ou ;
  59:  CALL APERA_PLACET(16,17,18,101) ;
  60:  IF R[101:status code apea]=0,JMP LBL[3] ;
  61:   ;
  62:  !Display error msg ;
  63:  MESSAGE[Error in locating parts] ;
  64:  JMP LBL[1] ;
  65:   ;
  66:  !Move to Placement ;
  67:  LBL[3:Drop Part] ;
  68:   ;
  69:J PR[18:Direct Ld 8] 100% FINE    ;
  70:   ;
  71:  !Loop ;
  72:  JMP LBL[1] ;
  73:   ;
/POS
/END
