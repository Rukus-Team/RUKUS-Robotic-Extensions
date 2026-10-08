/**
 * Hover documentation for the RAPID instructions, functions and data types a program
 * meets most. Keyed by the upper-cased word under the cursor.
 *
 * Kept short on purpose: the syntax line and what the thing does, plus a note where the
 * corpus shows a common trap. "Per ABB RAPID reference" marks facts taken from ABB's
 * instruction/data-type reference; the rest is plain description. SpotWare entries are
 * written from how the IRC5 corpus uses them and say so.
 */

export interface RapidDoc {
  title: string;
  /** one syntax line, RAPID-style: optional arguments in [ ] */
  syntax: string;
  description: string;
  notes?: string[];
  kind: 'instruction' | 'function' | 'type' | 'keyword';
}

const DOCS = new Map<string, RapidDoc>();
const add = (kind: RapidDoc['kind'], name: string, syntax: string, description: string, notes?: string[]) =>
  DOCS.set(name.toUpperCase(), { title: name, syntax, description, notes, kind });
const ins = (n: string, s: string, d: string, notes?: string[]) => add('instruction', n, s, d, notes);
const fn = (n: string, s: string, d: string, notes?: string[]) => add('function', n, s, d, notes);
const ty = (n: string, s: string, d: string, notes?: string[]) => add('type', n, s, d, notes);
const kw = (n: string, s: string, d: string, notes?: string[]) => add('keyword', n, s, d, notes);

const MOVE_OPTS = 'Optional: \\WObj (work object, default wobj0), \\TLoad (total load), \\ID (synchronised moves), \\Conc (run the next instructions while moving).';

// ---- motion ----
ins('MoveJ', 'MoveJ [\\Conc,] ToPoint, Speed [\\V|\\T], Zone [\\Z], Tool [\\WObj] [\\TLoad];',
  'Joint move: all axes start and stop together; the TCP path is not a straight line. Used for fast moves where the path shape does not matter.', [MOVE_OPTS]);
ins('MoveL', 'MoveL [\\Conc,] ToPoint, Speed [\\V|\\T], Zone [\\Z], Tool [\\WObj] [\\TLoad];',
  'Linear move: the TCP travels in a straight line to ToPoint at the programmed TCP speed.', [MOVE_OPTS]);
ins('MoveC', 'MoveC [\\Conc,] CirPoint, ToPoint, Speed, Zone, Tool [\\WObj] [\\TLoad];',
  'Circular move: the TCP moves along the circle through CirPoint to ToPoint. A full circle takes two MoveC instructions.', [MOVE_OPTS]);
ins('MoveAbsJ', 'MoveAbsJ [\\Conc,] ToJointPos [\\NoEOffs], Speed, Zone, Tool [\\WObj] [\\TLoad];',
  'Moves to an absolute axis position given as a jointtarget. No configuration or singularity issues: the axis angles are the target.',
  ['The tool and work object do not change where the robot goes, only the TCP speed and the load used.']);
ins('MoveJDO', 'MoveJDO ToPoint, Speed, Zone, Tool, Signal, Value;', 'Joint move that sets a digital output in the middle of the corner path of ToPoint (at the point itself with fine).');
ins('MoveLDO', 'MoveLDO ToPoint, Speed, Zone, Tool, Signal, Value;', 'Linear move that sets a digital output in the middle of the corner path of ToPoint (at the point itself with fine).');
ins('MoveExtJ', 'MoveExtJ ToJointPos, Speed, Zone;', 'Moves linear or rotating external axes only, without a TCP.');
ins('SearchL', 'SearchL [\\Stop|\\PStop|\\SStop|\\Sup,] Signal [\\Flanks], SearchPoint, ToPoint, Speed, Tool [\\WObj];',
  'Linear move towards ToPoint that records in SearchPoint where the signal changed.');
ins('TriggL', 'TriggL ToPoint, Speed, Trigg1 [\\T2..\\T8], Zone, Tool [\\WObj];',
  'Linear move with position events (triggdata set up by TriggIO, TriggEquip or TriggInt) fired along the path.');
ins('TriggJ', 'TriggJ ToPoint, Speed, Trigg1 [\\T2..\\T8], Zone, Tool [\\WObj];', 'Joint move with position events fired along the path.');
ins('StopMove', 'StopMove [\\Quick] [\\AllMotionTasks];', 'Stops robot and external axis movement; StartMove resumes it.');
ins('StartMove', 'StartMove [\\AllMotionTasks];', 'Resumes movement stopped with StopMove.');
ins('ConfL', 'ConfL \\On | \\Off;', 'Switches configuration monitoring for linear moves on or off.');
ins('ConfJ', 'ConfJ \\On | \\Off;', 'Switches configuration control for joint moves on or off.');
ins('SingArea', 'SingArea \\Wrist | \\Off;', 'How the robot passes near wrist singularities: \\Wrist lets the orientation deviate slightly to get through.');
ins('AccSet', 'AccSet Acc, Ramp;', 'Limits acceleration: Acc and Ramp are percentages of normal (100 = full).');
ins('VelSet', 'VelSet Override, Max;', 'Scales every programmed speed by Override percent and caps the TCP speed at Max mm/s.');
ins('GripLoad', 'GripLoad Load;', 'Tells the controller what payload the robot now holds (load0 = none).');
// SpotWare
ins('SpotL', 'SpotL ToPoint, Speed, Gun [\\GunD], Spot, Tool [\\WObj] [\\TLoad];',
  'SpotWare: linear move to ToPoint and make a spot weld there with the given gun and spot data. The move always ends in a fine point.',
  ['Argument order as the corpus writes it: `SpotL wp1, v500, Gun1\\GunD:=gunData1, sd_1, GunTCP\\WObj:=wobj1;`.']);
ins('SpotJ', 'SpotJ ToPoint, Speed, Gun [\\GunD], Spot, Tool [\\WObj] [\\TLoad];',
  'SpotWare: joint move to ToPoint and make a spot weld there.');
ins('CalibL', 'CalibL ToPoint, Speed, Gun [...], Zone, Tool [\\WObj] [\\TLoad];',
  'SpotWare: linear move followed by a servo-gun calibration (tip change / tip wear), as the corpus uses it.');
ins('CalibJ', 'CalibJ ToPoint, Speed, Gun [...], Zone, Tool [\\WObj] [\\TLoad];',
  'SpotWare: joint move followed by a servo-gun calibration (tip change / tip wear), as the corpus uses it.');

// ---- I/O ----
ins('SetDO', 'SetDO [\\SDelay] | [\\Sync,] Signal, Value;', 'Sets a digital output to 0 or 1. \\Sync waits until the signal has physically changed.');
ins('SetGO', 'SetGO Signal, Value | Dvalue;', 'Sets a group output to an integer value.');
ins('SetAO', 'SetAO Signal, Value;', 'Sets an analog output.');
ins('Set', 'Set Signal;', 'Sets a digital output to 1.');
ins('Reset', 'Reset Signal;', 'Sets a digital output to 0.');
ins('PulseDO', 'PulseDO [\\High] [\\PLength] Signal;', 'Pulses a digital output (0.2 s unless \\PLength says otherwise).');
ins('WaitDI', 'WaitDI Signal, Value [\\MaxTime] [\\TimeFlag];', 'Waits until a digital input has the value. Without \\TimeFlag, \\MaxTime running out raises ERR_WAIT_MAXTIME.');
ins('WaitDO', 'WaitDO Signal, Value [\\MaxTime] [\\TimeFlag];', 'Waits until a digital output has the value.');
ins('WaitGI', 'WaitGI Signal, [\\NOTEQ | \\LT | \\GT] Value [\\MaxTime] [\\TimeFlag];', 'Waits until a group input meets the condition.');
ins('WaitUntil', 'WaitUntil [\\InPos,] Cond [\\MaxTime] [\\TimeFlag] [\\PollRate];', 'Waits until a boolean expression is TRUE. \\InPos also waits for the robot to be in position.');
ins('WaitTime', 'WaitTime [\\InPos,] Time;', 'Waits the given number of seconds. \\InPos first waits for the robot to stop.');
ins('AliasIO', 'AliasIO FromSignal, ToSignal;', 'Connects a signal variable declared in RAPID to a signal in the I/O configuration.');

// ---- flow ----
ins('Stop', 'Stop [\\NoRegain | \\AllMoveTasks];', 'Stops program execution; the program can be restarted from the next instruction.');
ins('ExitCycle', 'ExitCycle;', 'Ends the current cycle and starts again from the main routine, resetting the call stack.');
ins('Break', 'Break;', 'Stops execution immediately, for debugging.');
ins('CallByVar', 'CallByVar Name, Number;', 'Calls the procedure whose name is the string Name followed by Number (e.g. "proc", 3 calls proc3).');
ins('Incr', 'Incr Name;', 'Adds 1 to a num or dnum.');
ins('Decr', 'Decr Name;', 'Subtracts 1 from a num or dnum.');
ins('Add', 'Add Name, AddValue;', 'Adds AddValue to a num or dnum.');
ins('Clear', 'Clear Name;', 'Sets a num or dnum to 0.');
ins('ErrWrite', 'ErrWrite [\\W,] Header, Reason [\\RL2] [\\RL3] [\\RL4];', 'Writes an entry to the controller event log. \\W makes it a warning instead of an error.');
ins('TPWrite', 'TPWrite String [\\Num] | [\\Bool] | [\\Pos] | [\\Orient];', 'Writes a line to the FlexPendant operator window.');
ins('TPErase', 'TPErase;', 'Clears the FlexPendant operator window.');
ins('TPReadFK', 'TPReadFK Answer, Text, FK1, FK2, FK3, FK4, FK5 [\\MaxTime] [\\DIBreak] [\\BreakFlag];', 'Shows a text and up to five function keys on the FlexPendant and returns the one pressed (1-5).');
ins('RETRY', 'RETRY;', 'In an ERROR handler: runs the instruction that raised the error again.');
ins('TRYNEXT', 'TRYNEXT;', 'In an ERROR handler: skips the instruction that raised the error and carries on after it.');

// ---- interrupts ----
ins('IDelete', 'IDelete Interrupt;', 'Cancels an interrupt subscription and frees its intnum.');
ins('ISignalDI', 'ISignalDI [\\Single] | [\\SingleSafe], Signal, TriggValue, Interrupt;', 'Orders an interrupt when a digital input changes to TriggValue (0, 1 or 2 = both edges).');
ins('ISignalDO', 'ISignalDO [\\Single] | [\\SingleSafe], Signal, TriggValue, Interrupt;', 'Orders an interrupt when a digital output changes.');
ins('ITimer', 'ITimer [\\Single] | [\\SingleSafe], Time, Interrupt;', 'Orders a timed interrupt, repeating unless \\Single.');
ins('ISleep', 'ISleep Interrupt;', 'Deactivates one interrupt; IWatch re-activates it.');
ins('IWatch', 'IWatch Interrupt;', 'Re-activates an interrupt deactivated with ISleep.');
kw('CONNECT', 'CONNECT Interrupt WITH TrapRoutine;', 'Binds an interrupt identity (intnum) to a TRAP routine. Connect before ordering the interrupt (ISignalDI, ITimer, ...).');

// ---- functions ----
fn('Offs', 'Offs(Point, XOffset, YOffset, ZOffset)', 'A robtarget displaced by X/Y/Z mm in the work object frame; the orientation is unchanged.');
fn('RelTool', 'RelTool(Point, Dx, Dy, Dz [\\Rx] [\\Ry] [\\Rz])', 'A robtarget displaced and/or rotated in the TOOL frame of Point.');
fn('CRobT', 'CRobT([\\TaskRef|\\TaskName] [\\Tool] [\\WObj])', 'The current robot position as a robtarget, for the given tool and work object.');
fn('CJointT', 'CJointT([\\TaskRef|\\TaskName])', 'The current axis angles as a jointtarget.');
fn('Present', 'Present(OptPar)', 'TRUE when the optional parameter was given in the call.');
fn('NumToStr', 'NumToStr(Val, Dec [\\Exp])', 'A num as a string with Dec decimals.');
fn('ValToStr', 'ValToStr(Val)', 'Any value as a string, the way it would be written in RAPID.');
fn('StrLen', 'StrLen(Str)', 'Number of characters in a string.');
fn('StrPart', 'StrPart(Str, ChPos, Len)', 'Len characters of Str starting at ChPos (1-based).');
fn('DInput', 'DInput(Signal)', 'The value of a digital input (the signal name can also be used directly).');
fn('GInputDnum', 'GInputDnum(Signal)', 'The value of a group input as a dnum, for groups wider than 23 bits.');
fn('Abs', 'Abs(Value)', 'Absolute value.');
fn('Round', 'Round(Val [\\Dec])', 'Rounds to Dec decimals (0 by default).');
fn('Trunc', 'Trunc(Val [\\Dec])', 'Truncates to Dec decimals (0 by default).');
fn('Dim', 'Dim(ArrPar, DimNo)', 'Number of elements in dimension DimNo of an array.');
fn('OpMode', 'OpMode()', 'The operating mode: OP_AUTO, OP_MAN_PROG or OP_MAN_TEST.');
fn('RunMode', 'RunMode([\\Main])', 'The run mode: RUN_CONT_CYCLE, RUN_INSTR_FWD, RUN_INSTR_BWD, RUN_SIM or RUN_STEP_MOVE.');

// ---- data types ----
ty('num', 'num', 'A number, integer or decimal. Integers are exact up to 8 388 608 (23 bits); use dnum above that.');
ty('dnum', 'dnum', 'A double-precision number; exact integers up to 4 503 599 627 370 496.');
ty('bool', 'bool', 'TRUE or FALSE.');
ty('string', 'string', 'Text of up to 80 characters, in double quotes. `""` is a quote inside a string, `\\\\` a backslash.');
ty('robtarget', 'robtarget := [[x,y,z],[q1,q2,q3,q4],[cf1,cf4,cf6,cfx],[eax_a,eax_b,eax_c,eax_d,eax_e,eax_f]]',
  'A robot position: TCP position in mm (trans), orientation as a quaternion (rot), axis configuration (robconf) and external axis positions (extax), in the work object used by the move.',
  ['9E+09 in extax means "no external axis here".', 'The configuration picks which of the robot\'s solutions to use: quadrants of axes 1, 4 and 6 and the cfx case.']);
ty('jointtarget', 'jointtarget := [[rax_1..rax_6],[eax_a..eax_f]]', 'An absolute axis position in degrees (mm for linear external axes), used by MoveAbsJ.', ['9E+09 means "no external axis here".']);
ty('tooldata', 'tooldata := [robhold, [[x,y,z],[q1..q4]], [mass, [cogx,cogy,cogz], [aom], ix, iy, iz]]',
  'A tool: whether the robot holds it, its TCP frame relative to the flange, and its load.');
ty('wobjdata', 'wobjdata := [robhold, ufprog, ufmec, [uframe], [oframe]]', 'A work object: the user frame and the object frame the positions are taught in.');
ty('loaddata', 'loaddata := [mass, [cog], [aom], ix, iy, iz]', 'A payload: mass in kg, centre of gravity in mm, axes of moment and inertia in kg m2.');
ty('speeddata', 'speeddata := [v_tcp, v_ori, v_leax, v_reax]', 'Speed: TCP mm/s, reorientation deg/s, linear and rotating external axes. Predefined v5 ... v7000, vmax.');
ty('zonedata', 'zonedata := [finep, pzone_tcp, pzone_ori, pzone_eax, zone_ori, zone_leax, zone_reax]',
  'How close the robot must get to a point before moving on. `fine` stops at the point; z0 ... z200 round the corner by that many mm.');
ty('signaldi', 'signaldi', 'A digital input signal.');
ty('signaldo', 'signaldo', 'A digital output signal.');
ty('signalgi', 'signalgi', 'A group of digital inputs read as one integer.');
ty('signalgo', 'signalgo', 'A group of digital outputs written as one integer.');
ty('signalai', 'signalai', 'An analog input signal.');
ty('signalao', 'signalao', 'An analog output signal.');
ty('intnum', 'intnum', 'An interrupt identity: CONNECT ties it to a TRAP, ISignalDI/ITimer/... order it.');
ty('clock', 'clock', 'A stopwatch: ClkStart, ClkStop, ClkReset, ClkRead.');
ty('errnum', 'errnum', 'An error number; ERRNO in an ERROR handler holds the one raised.');
ty('pos', 'pos := [x, y, z]', 'A position in mm.');
ty('orient', 'orient := [q1, q2, q3, q4]', 'An orientation as a unit quaternion.');
ty('pose', 'pose := [[x,y,z],[q1,q2,q3,q4]]', 'A frame: translation plus orientation.');
ty('confdata', 'confdata := [cf1, cf4, cf6, cfx]', 'Robot axis configuration.');

// ---- keywords ----
kw('VAR', 'VAR type name [:= value];', 'A variable. In a routine it is reset each call; at module level it keeps its value until the program pointer is reset.');
kw('PERS', 'PERS type name := value;', 'A persistent: its current value is written back into the module source, so it survives restarts and is saved with the program.');
kw('CONST', 'CONST type name := value;', 'A constant: set once in the declaration, read-only.');
kw('LOCAL', 'LOCAL PROC|FUNC|TRAP|VAR|PERS|CONST ...', 'Visible only inside this module.');
kw('TASK', 'TASK PERS type name := value;', 'A persistent shared only within this task, instead of across all tasks.');
kw('PROC', 'PROC Name([parameters]) ... ENDPROC', 'A procedure: a routine called as an instruction.');
kw('FUNC', 'FUNC type Name([parameters]) ... RETURN value; ... ENDFUNC', 'A function: a routine that returns a value and is used in expressions.');
kw('TRAP', 'TRAP Name ... ENDTRAP', 'An interrupt routine, run when an interrupt CONNECTed to it occurs. It has no parameters.');
kw('ERROR', 'ERROR [(errno, ...)]', 'Starts the routine\'s error handler. ERRNO holds the error; RETRY, TRYNEXT, RETURN or RAISE decide what happens next.');
kw('UNDO', 'UNDO', 'Starts the routine\'s undo handler, run when the program pointer leaves the routine before it finished.');
kw('BACKWARD', 'BACKWARD', 'Starts the routine\'s backward handler, run when the routine is stepped backwards.');
kw('RECORD', 'RECORD name\n  type field;\nENDRECORD', 'Declares a new data type made of named fields.');
kw('TEST', 'TEST expr\nCASE a, b: ...\nDEFAULT: ...\nENDTEST', 'Runs the CASE whose values match the expression, or DEFAULT.');

/** Documentation for a word under the cursor, or undefined. Case-insensitive. */
export function lookupRapidDoc(word: string): RapidDoc | undefined {
  return DOCS.get(word.toUpperCase());
}

/** Every documented name, upper-cased, for completion lists and tests. */
export function rapidDocNames(): string[] {
  return [...DOCS.keys()];
}

/** The doc as Markdown, the shape the hover provider shows. */
export function rapidDocMarkdown(d: RapidDoc): string {
  const out = [`**${d.title}** _(${d.kind})_`, '```rapid', d.syntax, '```', d.description];
  if (d.notes?.length) out.push('', ...d.notes.map(n => `- ${n}`));
  return out.join('\n');
}
