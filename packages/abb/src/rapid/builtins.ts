/**
 * Names RAPID knows without a declaration in the task: the system's instructions
 * (procedures), functions and data types. Upper-cased.
 *
 * Why this list exists, and why it is not trusted for errors: a procedure call to a name
 * that is neither declared in the task nor in this list is reported by the diagnostics,
 * but a controller also carries instructions from its options (SpotWare, Production
 * Manager, Integrated Vision, the site's own installed libraries) that no backup text
 * declares. So an unknown name is at most a warning. The list is what RobotWare 6 ships
 * in the base system and the common options, plus the SpotWare / Servo Tool Control
 * instructions the IRC5 corpus calls.
 */

const names: string[][] = [];
/** the upper-cased set for matching; the spelling as written is kept for completion (see {@link RAPID_BUILTIN_SPELLINGS}) */
const set = (s: string) => { const list = s.split(/\s+/).filter(Boolean); names.push(list); return new Set(list.map(x => x.toUpperCase())); };

/** Built-in and option instructions (called as `Name args;`). */
export const RAPID_INSTRUCTIONS: ReadonlySet<string> = set(`
  MoveJ MoveL MoveC MoveAbsJ MoveExtJ MoveJDO MoveLDO MoveCDO MoveJSync MoveLSync MoveCSync
  MoveJAO MoveLAO MoveCAO MoveJGO MoveLGO MoveCGO
  SearchJ SearchL SearchC SearchExtJ TriggJ TriggL TriggC TriggJIOs TriggLIOs TriggIO TriggEquip TriggInt
  TriggCheckIO TriggRampAO TriggSpeed TriggDataReset TriggStopProc TriggDataCopy TriggAbsJ
  StopMove StartMove StartMoveRetry StopMoveReset ClearPath StorePath RestoPath PathResol
  ConfJ ConfL SingArea AccSet VelSet PathAccLim CirPathMode GripLoad MechUnitLoad SoftAct SoftDeact
  SpeedRefresh WorldAccLim ActUnit DeactUnit SyncMoveOn SyncMoveOff SyncMoveUndo SyncMoveResume SyncMoveSuspend
  WaitSyncTask WaitRob WaitWObj DropWObj PDispOn PDispOff PDispSet EOffsOn EOffsOff EOffsSet
  TuneServo TuneReset IndAMove IndCMove IndDMove IndRMove IndReset CorrCon CorrDiscon CorrWrite CorrClear
  MotionSup MotionProcessModeSet CollDetect PathRecMoveBwd PathRecMoveFwd PathRecStart PathRecStop
  MToolRotCalib MToolTCPCalib SToolRotCalib SToolTCPCalib CalcRotAxisFrame HollowWristReset
  SafetyControlSync ActEventBuffer DeactEventBuffer SetLeadThrough SpeedLimAxis SpeedLimCheckPoint
  SpotJ SpotL SpotML CalibJ CalibL SetForce
  STCalib STCalcForce STClose STOpen STTune STTuneReset STIndGun STIndGunReset
  Set Reset SetDO SetAO SetGO PulseDO InvertDO WaitDI WaitDO WaitAI WaitAO WaitGI WaitGO
  WaitUntil WaitTime WaitLoad WaitTestAndSet AliasIO AliasIOReset IODisable IOEnable IOBusStart
  SetAllDataVal SetDataSearch GetDataVal SetDataVal GetSysData SetSysData StartLoad UnLoad Load EraseModule
  CheckProgRef Save SetupCyclicBool RemoveCyclicBool
  Stop ExitCycle Break CallByVar SystemStopAction RaiseToUser ErrRaise ErrLog ErrWrite SkipWarn
  ResetRetryCount ProcerrRecovery StepBwdPath
  IDelete ISignalDI ISignalDO ISignalAI ISignalAO ISignalGI ISignalGO ITimer ISleep IWatch
  IEnable IDisable IError IPers IRMQMessage IVarValue
  Add Clear Decr Incr ClkReset ClkStart ClkStop BitClear BitSet
  CopyRawBytes ClearRawBytes PackRawBytes UnpackRawBytes PackDNHeader ReadAnyBin WriteAnyBin
  ReadBlock WriteBlock ReadCfgData WriteCfgData SaveCfgData TextTabInstall
  WZBoxDef WZCylDef WZSphDef WZHomeJointDef WZLimJointDef WZLimSup WZDOSet WZDisable WZEnable WZFree
  TPErase TPWrite TPReadFK TPReadNum TPReadDnum TPShow UIMsgBox UIShow
  Open Close Rewind Write WriteBin WriteStrBin WriteRawBytes ReadRawBytes ClearIOBuff
  CopyFile RemoveFile RenameFile MakeDir RemoveDir OpenDir CloseDir
  SocketCreate SocketConnect SocketSend SocketReceive SocketClose SocketBind SocketListen SocketAccept
  SocketReceiveFrom SocketSendTo RMQSendMessage RMQFindSlot RMQGetMessage RMQGetMsgData RMQGetMsgHeader
  RMQReadWait RMQEmptyQueue RMQSendWait SpyStart SpyStop
`);

/** Built-in functions (called as `Name(...)` in an expression). */
export const RAPID_FUNCTIONS: ReadonlySet<string> = set(`
  Abs ACos ASin ATan ATan2 Cos Sin Tan Exp Pow Sqrt Round Trunc AbsDnum RoundDnum TruncDnum
  NumToDnum DnumToNum StrToVal ValToStr NumToStr DnumToStr StrLen StrPart StrFind StrMatch StrMemb StrOrder
  StrMap StrToByte ByteToStr StrDigCmp StrDigCalc Offs RelTool CRobT CJointT CPos CTool CWObj CSpeedOverride
  CalcJointT CalcRobT OrientZYX EulerZYX NOrient PoseInv PoseMult PoseVect DefFrame DefDFrame DefAccFrame
  VectMagn DotProd MaxRobSpeed Distance Present ArgName Dim Type IsPers IsVar
  DInput DOutput AInput AOutput GInput GOutput GInputDnum GOutputDnum TestDI TestAndSet ValidIO IOUnitState
  ClkRead CDate CTime GetTime GetNextSym GetTaskName GetSysInfo GetMecUnitName IsStopStateEvent IsSysId
  IsMechUnitActive TaskRunMec TaskRunRob OpMode RunMode RobOS NonMotionMode ExecHandler ExecLevel ProgMemFree
  ReadNum ReadStr ReadBin ReadMotor ReadStrBin ReadDir FileSize FileTime FSSize IsFile ModExist ModTime
  BitAnd BitOr BitXOr BitNeg BitLSh BitRSh BitCheck BitAndDnum BitOrDnum BitXOrDnum BitNegDnum BitLShDnum
  BitRShDnum BitCheckDnum RawBytesLen SocketGetStatus SocketPeek TextGet TextTabGet TextTabFreeToUse
  UIAlphaEntry UIClientExist UIListView UIMessageBox UINumEntry UINumTune UIDnumEntry UIDnumTune CorrRead
  PFRestart PathLevel PPMovedInManMode IsSyncMoveOn TriggDataValid GetServiceInfo GetModalPayloadMode
  GetSignalOrigin GetNextMechUnit GetTSPStatus MirPos RMQGetSlotName
  STIsCalib STIsClosed STIsIndGun STIsOpen
`);

/** Built-in data types. */
export const RAPID_TYPES: ReadonlySet<string> = set(`
  num dnum bool string byte switch robtarget jointtarget pos orient pose confdata extjoint robjoint
  tooldata wobjdata loaddata speeddata zonedata stoppointdata signaldi signaldo signalai signalao signalgi signalgo
  intnum clock errnum errstr errdomain errtype trapdata triggdata triggios triggiosdnum triggstrgo
  iodev dir rawbytes mecunit taskid tasks syncident identno shapedata wztemporary wzstationary
  opnum execmode symnum event_type handler_type datapos btnres listitem icondata socketdev socketstatus
  rmqslot rmqheader rmqmessage pathrecid tpnum corrdescr tunetype paridnum
  spotdata gunnum forcedata simdata
`);

/** Every built-in name spelled as RobotWare writes it (MoveL, not MOVEL), by kind, for completion. */
export const RAPID_BUILTIN_SPELLINGS = { instructions: names[0], functions: names[1], types: names[2] } as const;
