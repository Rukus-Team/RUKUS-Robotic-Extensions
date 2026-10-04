/**
 * Hover documentation for TP instructions. Keyed by a matcher run against the
 * instruction body (line number and terminator removed).
 */

import { CATALOG_DOCS, CATALOG_COMPLETIONS } from './syntaxCatalog';

export interface TpDoc {
  title: string;
  syntax: string;
  description: string;
  notes?: string[];
  /** the software option the instruction needs, e.g. "J512 Line Tracking" */
  option?: string;
  /** where the syntax comes from (manual and page) */
  source?: string;
  /** what a real controller made of it (data/tp-syntax-verified.json), e.g. "Verified on a FANUC controller (...)" */
  verified?: string;
}

/** `anywhere`: a motion option / operand / call that is never the start of an instruction body */
interface DocEntry { match: RegExp; doc: TpDoc; anywhere?: boolean }

const D: DocEntry[] = [];
function add(match: RegExp, title: string, syntax: string, description: string, notes?: string[]) {
  D.push({ match, doc: { title, syntax, description, notes } });
}

// ---- Comments ----
add(/^--eg\b/i, 'Extended comment (multi-line)', '--eg:<text>\n    :  <more text> ;',
  'A comment that runs over several lines. The controller ignores it, like a ! comment, but it can hold far more than 32 characters: the text carries on over ":" continuation lines and only the last line carries the " ;".',
  ['Only the first line takes a line number; the continuation lines are part of it.', 'Written from the pendant\'s EDCMD > Comment editor on newer software.']);

// ---- Registers written in shapes the plain R[n]= rule does not cover ----
add(/^R\[R\[/, 'Indirect register assignment', 'R[R[n]]=<value>',
  'Writes to the register whose NUMBER is held in R[n]. The target changes at run time, so the cross-reference cannot know which register is written; treat every register in the range R[n] can take as written by this line.');
add(/^PR\[\d+\s*,\s*\d+(?::[^\]]*)?\]\s*=/, 'Position register element assignment', 'PR[i,j]=<value>',
  'Writes one element of position register i: j = 1..6 is X Y Z W P R for a cartesian PR, or J1..J6 for a joint PR; 7..9 are the extended axes. The rest of the register is untouched.',
  ['Mixing representations (writing X into a joint PR) is refused by the controller.']);
add(/^TOOL_OFFSET CONDITION\b/, 'Tool offset condition', 'TOOL_OFFSET CONDITION PR[n]',
  'Sets the tool-frame offset that later motion lines with the Tool_Offset option apply: each such move is shifted by PR[n], expressed in the tool frame. Stays in force until the next TOOL_OFFSET CONDITION or the program ends.',
  ['OFFSET CONDITION is the user-frame equivalent.']);

// ---- Motion ----
add(/^J\s/, 'Joint motion', 'J P[n] <speed>% <FINE|CNTn> [options]',
  'Moves all axes so they start and stop together. The tool path is not a straight line. Speed is a percentage of the maximum joint speed.',
  ['Fastest way to move between distant points.', 'Use for approach/depart moves where the path shape does not matter.']);
add(/^L\s/, 'Linear motion', 'L P[n] <speed>mm/sec <FINE|CNTn> [options]',
  'Moves the TCP in a straight line at the programmed speed. Speed units: mm/sec, cm/min, inch/min, sec (time-based) or msec.',
  ['Orientation is interpolated smoothly between the two positions.', 'Watch for singularities (Wjnt option can help).']);
add(/^C\s/, 'Circular motion', 'C P[via]\n    P[dest] <speed>mm/sec <FINE|CNTn>',
  'Moves the TCP along an arc through the via position to the destination. The second line (":  P[dest] ...") is part of the same instruction.');
add(/^A\s/, 'Circular arc motion', 'A P[n] <speed>mm/sec <FINE|CNTn>',
  'Circular arc through a chain of consecutive A instructions. Requires the Circular Arc option; at least three consecutive A points define the arc.');
add(/^S\s/, 'Spline motion', 'S P[n] <speed>mm/sec <FINE|CNTn>',
  'Spline motion through consecutive S points (Spline Motion option).');

// ---- Motion options (matched anywhere on the line) ----
add(/\bFINE\b/, 'FINE termination', '... FINE',
  'The robot stops exactly at the position before executing the next instruction.');
add(/\bCNT\d{1,3}\b/, 'CNT termination', '... CNT<0-100>',
  'Continuous termination. The robot rounds the corner near the position without stopping; CNT100 is the largest rounding, CNT0 decelerates near zero but still does not settle.');
add(/\bACC\d{1,3}\b/, 'Acceleration override', '... ACC<0-150>',
  'Scales acceleration/deceleration for this motion. Values above 100 need the corresponding option.');
add(/\bOffset,PR\[/, 'Position offset', '... Offset,PR[n]',
  'Adds PR[n] (interpreted in the user frame of the destination) to the destination position.');
add(/\bTool_Offset,PR\[/, 'Tool offset', '... Tool_Offset,PR[n]',
  'Adds PR[n] interpreted in the tool frame to the destination position.');
add(/\bVOFFSET,VR\[/, 'Vision offset', '... VOFFSET,VR[n]',
  'Applies the iRVision offset stored in vision register VR[n] to the destination.');
add(/\bSkip,LBL\[/, 'Skip', '... Skip,LBL[n]',
  'If the SKIP CONDITION becomes true during the motion the robot stops and execution continues at the next line; if it never becomes true, execution jumps to LBL[n].');
add(/\bINC\b/, 'Incremental motion', '... INC',
  'The position data is treated as an increment from the current position instead of an absolute location.');
add(/\bWjnt\b/, 'Wrist joint', '... Wjnt',
  'Wrist axes move in joint mode during a linear/circular motion so wrist singularities can be passed. Orientation is not kept constant.');
add(/\bRTCP\b/, 'Remote TCP', '... RTCP',
  'The tool speed is controlled relative to a stationary remote TCP (Remote TCP option).');
add(/\bPTH\b/, 'Path', '... PTH',
  'Improves path accuracy of short CNT moves.');
add(/\bCOORD\b/, 'Coordinated motion', '... COORD',
  'Coordinated motion with a positioner group.');
add(/\bBREAK\b/, 'Break', '... BREAK',
  'Ends look-ahead here so the following logic instruction executes only after the motion completes.');
add(/\bTB\s/, 'Time before', '... TB <sec>,<action>',
  'Executes the action (CALL, DO=, etc.) the given number of seconds before the motion finishes.');
add(/\bTA\s/, 'Time after', '... TA <sec>,<action>',
  'Executes the action the given number of seconds after the motion finishes.');
add(/\bDB\s/, 'Distance before', '... DB <mm>,<action>',
  'Executes the action when the TCP is the given distance from the destination.');
add(/\bEV\d*%/, 'Extended velocity', '... EV<n>%',
  'Speed of the extended axis (e.g. a track) as a percentage.');

// ---- Program flow ----
add(/^LBL\[/, 'Label', 'LBL[n[:comment]]',
  'Defines a jump target. Label numbers 1–32767. Duplicates are not allowed in one program.');
add(/^JMP LBL\[/, 'Jump to label', 'JMP LBL[n]',
  'Unconditionally continues execution at LBL[n]. The label can be indirect: JMP LBL[R[1]].');
add(/^CALL\s/, 'Call program', 'CALL <program>[(arg1,arg2,...)]',
  'Runs another program and returns when it ends. Up to 10 arguments are received by the callee as AR[1]…AR[10]. The program name can be indirect: CALL SR[1] or CALL PROG[n].');
add(/^RUN\s/, 'Run program (multitask)', 'RUN <program>',
  'Starts another program as a separate task and continues immediately. The started program must not use the same motion group (see DEFAULT_GROUP).');
add(/^IF\s.*\bTHEN\b/, 'IF ... THEN block', 'IF (<mixed logic>) THEN\n  ...\n[ELSE]\n  ...\nENDIF',
  'Mixed-logic conditional block. The condition is written in parentheses and can combine AND/OR/NOT, I/O, registers and comparisons.');
add(/^IF\s/, 'IF instruction', 'IF <cond>,<action>',
  'If the condition is true the action is executed. Actions: JMP LBL[n], CALL prog, or (mixed logic) assignments. Conditions can be chained with AND or OR, but not both in one line.');
add(/^ELSE\b/, 'ELSE', 'ELSE', 'Alternative branch of an IF ... THEN block.');
add(/^ENDIF\b/, 'ENDIF', 'ENDIF', 'Closes an IF ... THEN block.');
add(/^SELECT\s/, 'SELECT', 'SELECT R[n]=<v1>,<action>\n       =<v2>,<action>\n       ELSE,<action>',
  'Multi-way branch on a register value. Each case line is its own TP line starting with "=".');
add(/^\s*=\S+,\s*(JMP|CALL)/, 'SELECT case', '       =<value>,<action>',
  'Case line of a preceding SELECT instruction.');
add(/^ELSE,/, 'SELECT default', '       ELSE,<action>', 'Default branch of a SELECT instruction.');
add(/^FOR\s/, 'FOR loop', 'FOR R[n]=<start> TO|DOWNTO <end>\n  ...\nENDFOR',
  'Loops while incrementing (TO) or decrementing (DOWNTO) the register. Loops can be nested 10 deep.');
add(/^ENDFOR\b/, 'ENDFOR', 'ENDFOR', 'Closes a FOR loop.');
add(/^WAIT\s+[\d.]+|^WAIT\s+R\[.*\]\s*(\(sec\))?\s*$/, 'Wait (time)', 'WAIT <sec>(sec)',
  'Pauses execution for the given time. Maximum 327.67 sec unless the value is in a register.');
add(/^WAIT\s/, 'Wait (condition)', 'WAIT <cond> [TIMEOUT,LBL[n]]',
  'Waits until the condition is true. With TIMEOUT,LBL[n] execution jumps to the label after $WAITTMOUT (default 30 s) expires.');
add(/^TIMEOUT,/, 'Timeout', '... TIMEOUT,LBL[n]', 'Timeout branch of a WAIT instruction.');
add(/^SKIP CONDITION/, 'Skip condition', 'SKIP CONDITION <cond>',
  'Sets the condition monitored by motion instructions that carry the Skip,LBL[n] option.');
add(/^ABORT\b/, 'Abort', 'ABORT', 'Aborts the program (and any called programs).');
add(/^PAUSE\b/, 'Pause', 'PAUSE', 'Pauses the program. Resume from the pendant or via UI[6] START.');
add(/^END\b/, 'End', 'END', 'Ends the program and returns to the caller if any.');
add(/^RETURN\b/, 'Return', 'RETURN', 'Ends the program and returns to the caller (equivalent to END for called programs).');

// ---- Registers ----
add(/^R\[[^\]]+\]\s*=/, 'Register assignment', 'R[n]=<value|expr>',
  'Assigns a value to a numeric register. Expressions can use + - * / DIV MOD with up to 5 operands. Operands: constants, R[], AR[], GI[], AI[], TIMER[], $sysvar, DI/DO (as 1/0 in mixed logic).');
add(/^PR\[\d+\s*,\s*\d+\]\s*=/, 'Position register element', 'PR[i,j]=<value>',
  'Assigns one element of a position register: j=1..6 are X,Y,Z,W,P,R (or J1..J6 for joint PRs), 7..9 extended axes.');
add(/^PR\[[^\]]+\]\s*=/, 'Position register assignment', 'PR[n]=<pos>',
  'Assigns a position to PR[n]. Sources: LPOS (current cartesian), JPOS (current joint), P[n], PR[m], UFRAME[n], UTOOL[n], or expressions such as PR[1]+PR[2].');
add(/^SR\[[^\]]+\]\s*=/, 'String register assignment', 'SR[n]=<string|expr>',
  'Assigns a string. Functions: SR[1]=SR[2]+SR[3] (concat), STRLEN, FINDSTR, SUBSTR, and number-to-string via R[n].');
add(/^UFRAME\[\d+\]\s*=/, 'User frame assignment', 'UFRAME[n]=PR[m]', 'Overwrites user frame n with the position register.');
add(/^UTOOL\[\d+\]\s*=/, 'Tool frame assignment', 'UTOOL[n]=PR[m]', 'Overwrites tool frame n with the position register.');
add(/^UFRAME_NUM\s*=/, 'Active user frame', 'UFRAME_NUM=<0-9|R[n]>',
  'Selects the active user frame. Positions record the UF they were taught in; executing a motion while a different frame is active raises a frame-mismatch alarm.');
add(/^UTOOL_NUM\s*=/, 'Active tool frame', 'UTOOL_NUM=<1-10|R[n]>',
  'Selects the active tool frame. Positions record UT; a mismatch at execution time raises an alarm.');
add(/^PAYLOAD\[/, 'Payload schedule', 'PAYLOAD[n]', 'Activates payload schedule n (set up under MENU > SYSTEM > Motion).');
add(/^OVERRIDE\s*=/, 'Speed override', 'OVERRIDE=<1-100>%', 'Sets the general speed override, same as the pendant +/- keys.');
add(/^TIMER\[/, 'Timer', 'TIMER[n]=START|STOP|RESET',
  'Controls program timer n. Read the elapsed time with R[m]=TIMER[n] (in seconds). Overflow after 2147483 s; check TIMER_OVERFLOW[n].');
add(/^UALM\[/, 'User alarm', 'UALM[n]',
  'Posts user alarm n (UALM-0nn) with the message configured under MENU > SETUP > User Alarm. Severity is set by $UALRM_SEV[n].');
add(/^MESSAGE\[/, 'Message', 'MESSAGE[text]', 'Writes text to the USER screen and switches to it.');
add(/^MONITOR END\b/, 'Monitor end', 'MONITOR END <cond_prog>', 'Stops the condition monitor program.');
add(/^MONITOR\b/, 'Monitor', 'MONITOR <cond_prog>', 'Starts a condition-handler program (created with the Cond type) that runs in parallel and reacts with WHEN ... CALL.');
add(/^WHEN\b/, 'When', 'WHEN <cond>,CALL <prog>', 'Condition handler action inside a Cond program.');
add(/^RSR\[/, 'RSR', 'RSR[n]=ENABLE|DISABLE', 'Enables or disables Robot Service Request n.');
add(/^ERROR_PROG\s*=/, 'Error program', 'ERROR_PROG=<prog>', 'Program to run automatically when an error occurs (Error Recovery option).');
add(/^RESUME_PROG(\[[^\]]*\])?\s*=/, 'Resume program', 'RESUME_PROG[n]=<prog>', 'Program resumed after the error program (Automatic Error Recovery, J924). The index form RESUME_PROG[n:comment]= is what the controller writes.');
add(/^MAINT_PROG(\[[^\]]*\])?\s*=/, 'Maintenance program', 'MAINT_PROG[n]=<prog>', 'Program used by Automatic Error Recovery (J924) for maintenance.');
add(/^CLEAR_RESUME_PROG\b/, 'Clear resume program', 'CLEAR_RESUME_PROG', 'Clears the resume program setting.');
add(/^RETURN_PATH_DSBL\b/, 'Return path disable', 'RETURN_PATH_DSBL', 'Disables automatic return-to-path after the error program.');
add(/^LOCK PREG\b/, 'Lock position registers', 'LOCK PREG', 'Locks all position registers so other tasks cannot change them until UNLOCK PREG.');
add(/^UNLOCK PREG\b/, 'Unlock position registers', 'UNLOCK PREG', 'Releases position registers locked with LOCK PREG.');
add(/^SEMAPHORE\[/, 'Semaphore', 'SEMAPHORE[n]=ON|OFF', 'Sets a multitasking semaphore.');
add(/^COL DETECT (ON|OFF)/, 'Collision detect', 'COL DETECT ON|OFF', 'Enables or disables collision detection.');
add(/^COL GUARD ADJUST/, 'Collision guard sensitivity', 'COL GUARD ADJUST <1-200>', 'Adjusts collision guard sensitivity (100 = normal, higher = more sensitive).');
add(/^\$/, 'System variable assignment', '$VAR=<value>', 'Writes a system variable. Both scalar variables ($WAITTMOUT) and structure fields ($MCR.$GENOVERRIDE) can be written when the variable is RW.');
add(/^GET_VAR\b/, 'Get variable', 'GET_VAR(<prog>,<var>,R[n])', 'Reads a KAREL/system variable into a register (KAREL var access).');
add(/^SET_VAR\b/, 'Set variable', 'SET_VAR(<prog>,<var>,<value>)', 'Writes a KAREL/system variable.');

// ---- I/O ----
add(/^DO\[[^\]]+\]\s*=\s*PULSE/, 'Pulsed output', 'DO[n]=PULSE[,<sec>sec]',
  'Turns the output on for the time given (default $DEFPULSE, 0.1 s units) and then off. Execution does not wait for the pulse to finish.');
add(/^(DO|RO|SO|UO|WO|SPO)\[[^\]]+\]\s*=/, 'Digital output', 'DO[n]=ON|OFF|PULSE|R[m]|DI[m]|(mixed logic)',
  'Sets a digital output. Assigning a register writes 0→OFF, non-zero→ON. Mixed logic form: DO[1]=(DI[1] AND !DI[2]).');
add(/^F\[[^\]]+\]\s*=/, 'Flag', 'F[n]=ON|OFF|(mixed logic)', 'Sets internal flag n (F[1]–F[1024]). Flags are software I/O shared by all tasks.');
add(/^M\[[^\]]+\]\s*=/, 'Marker', 'M[n]=ON|OFF', 'Sets marker n (used by the background logic editor).');
add(/^GO\[[^\]]+\]\s*=/, 'Group output', 'GO[n]=<value>|R[m]', 'Writes an integer to group output n (the bit pattern spans the configured points).');
add(/^AO\[[^\]]+\]\s*=/, 'Analog output', 'AO[n]=<value>|R[m]', 'Writes a value to analog output n.');
add(/^R\[[^\]]+\]\s*=\s*(GI|AI|DI|RI|UI|SI)\[/, 'Read input to register', 'R[n]=GI[m]', 'Stores the current input value in a register (digital inputs read as 1/0).');

// ---- Application ----
add(/^VISION RUN_FIND/, 'Vision run find', "VISION RUN_FIND '<process>' [CAMERA_VIEW[n]]",
  'Runs an iRVision vision process. Results are queued; retrieve them with VISION GET_OFFSET.');
add(/^VISION GET_OFFSET/, 'Vision get offset', "VISION GET_OFFSET '<process>' VR[n] JMP LBL[m]",
  'Retrieves the next found result into vision register VR[n]. If none was found, jumps to LBL[m].');
add(/^VISION GET_NFOUND/, 'Vision get number found', "VISION GET_NFOUND '<process>' R[n]", 'Stores the number of found parts in R[n].');
add(/^VISION GET_PASSFAIL/, 'Vision pass/fail', "VISION GET_PASSFAIL '<process>' R[n]", 'Stores the inspection result (1 pass / 0 fail) in R[n].');
add(/^VISION CAMERA_CALIB/, 'Camera calibration', "VISION CAMERA_CALIB '<calib>' REQUEST=n", 'Runs a camera calibration step (robot-generated grid calibration).');
add(/^VISION SET_REFERENCE/, 'Set vision reference', "VISION SET_REFERENCE '<process>'", 'Sets the reference position for the vision process.');
add(/^VISION OVERRIDE\b/, 'Vision override', "VISION OVERRIDE '<override>' <value>|R[n]", 'Overrides a vision process parameter (exposure, etc.) with a value or a register for the next run (iRVision Operator\'s Manual B-83914EN-1).');
add(/^VISION\b/, 'Vision instruction', 'VISION <sub-instruction>', 'iRVision instruction.');
add(/^SPOT\[/, 'Spot weld', 'SPOT[SD=n,P=n,t=n,S=n,ED=n]',
  'Spot welding instruction: SD = squeeze distance schedule, P = pressure schedule, t = weld time/schedule, S = weld schedule, ED = end distance. Usually appears as a motion option.');
add(/^PRESSURE\[/i, 'Servo gun pressure', 'Pressure[n]', 'Closes the servo gun with pressure schedule n.');
add(/^TIP ?DRESS\b/i, 'Tip dress', 'TIPDRESS[SD=..,P=..,t=..,TD=..,ED=..]', 'Runs the tip dressing sequence (servo gun / SpotTool+). Written as one word, TIPDRESS, in current software.');
add(/^Arc Start|^ARC START|^Weld Start/, 'Arc start', 'Arc Start[n]', 'Starts arc welding with weld schedule n (usually as motion option).');
add(/^Arc End|^ARC END|^Weld End/, 'Arc end', 'Arc End[n]', 'Ends arc welding with end schedule n.');
add(/^Weave\b/, 'Weave', 'Weave <pattern>[n]', 'Starts weaving with weave schedule n.');
add(/^Track (TAST|AVC)\b|^TRACK (TAST|AVC)\b/, 'Arc seam tracking', 'Track TAST[i] | Track AVC[i] | Track End', 'Starts through-arc seam tracking (TAST) or arc voltage control (AVC) with schedule i; Track End stops it (ArcTool).');
add(/^TRACK\b|^Track\b/, 'Tracking', 'Track ... | Track End', 'Starts or ends a tracking function: arc seam tracking (TAST/AVC) or sensor tracking in ArcTool, line tracking with the Line Tracking option.');
add(/^ACC\s*=?/, 'ACC (instruction)', 'ACC <value>', 'Acceleration override applied as a standalone instruction to following motions.');
add(/^POINT_LOGIC/, 'Point logic', 'POINT_LOGIC ...', 'Point logic instruction.');

// ---- Comments ----
add(/^!/, 'Comment', '!text', 'Comment line. Up to 32 characters are shown on the pendant; longer text is preserved in the .ls file.');
add(/^\/\//, 'Remark', '//text', 'Remark line: the controller ignores it completely (it is not even shown on the pendant as a comment). Use it to disable an instruction without deleting it.');

// ---- Argument register ----
add(/^AR\[/, 'Argument register', 'AR[n]', 'Argument n passed by the caller via CALL prog(arg1,...). Read-only; up to 10 arguments.');

// ---- From the FANUC manuals (generated catalog, scripts/build-tp-syntax.mjs): option instructions,
// motion options, operands, functions, option macros and FANUC-supplied programs. After the
// hand-written entries above, so those win where both match.
for (const c of CATALOG_DOCS) {
  const doc: TpDoc = { title: c.title, syntax: c.syntax, description: c.description, notes: c.notes, option: c.option, source: c.source, verified: c.verified };
  for (const re of c.res) {
    try { D.push({ match: new RegExp((c.anywhere ? '' : '^') + re, 'i'), doc, anywhere: c.anywhere }); } catch { /* a form that did not make a valid regex */ }
  }
}

export function lookupTpDoc(body: string): TpDoc | undefined {
  const b = body.trim();
  for (const e of D) if (!e.anywhere && e.match.test(b)) return e.doc;
  return undefined;
}

/** All docs that match anywhere on the line (for motion options etc.) */
export function lookupTpDocsAt(body: string, col: number): TpDoc[] {
  const b = body;
  const out: TpDoc[] = [];
  for (const e of D) {
    const re = new RegExp(e.match.source.replace(/^\^/, ''), e.match.flags);
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    while ((m = globalRe.exec(b))) {
      if (col >= m.index && col <= m.index + m[0].length) { out.push(e.doc); break; }
      if (m[0].length === 0) break;
    }
  }
  return out;
}

export interface DataKindDoc { name: string; description: string; range?: string }
export const DATA_KIND_DOCS: Record<string, DataKindDoc> = {
  R: { name: 'Numeric register', description: 'General purpose numeric register (integer or real).', range: 'R[1]–R[200] by default; $NUMREG count is configurable' },
  PR: { name: 'Position register', description: 'Stores a position (cartesian or joint) for one or more groups. PR[i,j] addresses one element.', range: 'PR[1]–PR[100] by default' },
  SR: { name: 'String register', description: 'Stores up to 254 characters.', range: 'SR[1]–SR[25] by default' },
  AR: { name: 'Argument register', description: 'Argument passed by the calling program.', range: 'AR[1]–AR[10]' },
  VR: { name: 'Vision register', description: 'iRVision result: found position, offset frame, model ID, encoder count.', range: 'VR[1]–VR[10] by default' },
  GP: { name: 'Group', description: 'Motion group qualifier.' },
  TIMER: { name: 'Program timer', description: 'Elapsed-time timer controlled with START/STOP/RESET.', range: 'TIMER[1]–TIMER[10] by default' },
  UALM: { name: 'User alarm', description: 'User-defined alarm message.', range: 'UALM[1]–UALM[10] by default' },
  DR: { name: 'Data register', description: 'Data register (some application options).' },
  PL: { name: 'Pallet register', description: 'Palletizing register (row, column, layer).' },
  DI: { name: 'Digital input', description: 'General purpose digital input, mapped to rack/slot/start via I/O config.' },
  DO: { name: 'Digital output', description: 'General purpose digital output.' },
  RI: { name: 'Robot input', description: 'Robot (end effector) input on the wrist connector.' },
  RO: { name: 'Robot output', description: 'Robot (end effector) output on the wrist connector.' },
  GI: { name: 'Group input', description: 'Group input: several DI points read as one integer.' },
  GO: { name: 'Group output', description: 'Group output: several DO points written as one integer.' },
  AI: { name: 'Analog input', description: 'Analog input channel.' },
  AO: { name: 'Analog output', description: 'Analog output channel.' },
  UI: { name: 'UOP input', description: 'User Operator Panel input. UI[1] IMSTP, UI[2] HOLD, UI[3] SFSPD, UI[4] CSTOPI, UI[5] FAULT RESET, UI[6] START, UI[7] HOME, UI[8] ENBL, UI[9-16] RSR1-8/PNS1-8, UI[17] PNSTROBE, UI[18] PROD_START.' },
  UO: { name: 'UOP output', description: 'User Operator Panel output. UO[1] CMDENBL, UO[2] SYSRDY, UO[3] PROGRUN, UO[4] PAUSED, UO[5] HELD, UO[6] FAULT, UO[7] ATPERCH, UO[8] TPENBL, UO[9] BATALM, UO[10] BUSY, UO[11-18] ACK1-8/SNO1-8, UO[19] SNACK, UO[20] RESERVED.' },
  SI: { name: 'SOP input', description: 'Standard Operator Panel input (buttons on the cabinet).' },
  SO: { name: 'SOP output', description: 'Standard Operator Panel output (lamps on the cabinet).' },
  F: { name: 'Flag', description: 'Internal software flag shared by all tasks.', range: 'F[1]–F[1024]' },
  M: { name: 'Marker', description: 'Internal marker used by the background logic editor.' },
  WI: { name: 'Weld input', description: 'Arc welding input.' },
  WO: { name: 'Weld output', description: 'Arc welding output.' },
  WSI: { name: 'Weld stick input', description: 'Weld stick detection input.' },
  WSO: { name: 'Weld stick output', description: 'Weld stick detection output.' },
  SPI: { name: 'Spot input', description: 'Spot welding input.' },
  SPO: { name: 'Spot output', description: 'Spot welding output.' },
};

/** Completion items for TP instructions: label, insert text (snippet syntax), detail */
/**
 * What the start of an instruction offers. ORDER MATTERS: the provider sorts by position in
 * this table, so within a prefix the plainest shape comes first - typing `PR` and taking
 * the top entry gives `PR[1]`, not an element assignment. `suggest` re-opens the list once
 * the snippet is in, because the caret is left inside a `[ ]` that has its own list.
 */
export const TP_INSTRUCTION_COMPLETIONS: Array<{ label: string; insert: string; detail: string; suggest?: boolean }> = [
  { label: 'J P[] ... FINE', insert: 'J P[${1:1}] ${2:100}% ${3|FINE,CNT100|}', detail: 'Joint motion' },
  { label: 'L P[] ... FINE', insert: 'L P[${1:1}] ${2:500}mm/sec ${3|FINE,CNT100|}', detail: 'Linear motion' },
  { label: 'J PR[] ... FINE', insert: 'J PR[${1:1}] ${2:100}% ${3|FINE,CNT100|}', detail: 'Joint motion to PR' },
  { label: 'L PR[] ... FINE', insert: 'L PR[${1:1}] ${2:500}mm/sec ${3|FINE,CNT100|}', detail: 'Linear motion to PR' },
  { label: 'LBL[]', insert: 'LBL[${1:1}${2::name}]', detail: 'Label' },
  { label: 'JMP LBL[]', insert: 'JMP LBL[${1:1}]', detail: 'Jump' },
  { label: 'CALL', insert: 'CALL ', detail: 'Call program - then pick it from the list', suggest: true },
  { label: 'RUN', insert: 'RUN ', detail: 'Run program as task - then pick it from the list', suggest: true },
  { label: 'IF ,JMP LBL[]', insert: 'IF ${1:R[1]}=${2:1},JMP LBL[${3:1}]', detail: 'Conditional jump' },
  { label: 'IF ,CALL', insert: 'IF ${1:DI[1]}=${2|ON,OFF|},CALL ${3:PROGRAM}', detail: 'Conditional call' },
  { label: 'IF () THEN', insert: 'IF (${1:R[1]=1}) THEN', detail: 'Mixed logic IF block' },
  { label: 'ELSE', insert: 'ELSE', detail: 'IF block else' },
  { label: 'ENDIF', insert: 'ENDIF', detail: 'Close IF block' },
  { label: 'SELECT', insert: 'SELECT R[${1:1}]=${2:1},JMP LBL[${3:1}]', detail: 'Select' },
  { label: 'FOR', insert: 'FOR R[${1:1}]=${2:1} TO ${3:10}', detail: 'FOR loop' },
  { label: 'ENDFOR', insert: 'ENDFOR', detail: 'Close FOR loop' },
  { label: 'WAIT condition', insert: 'WAIT ${1:DI[1]}=${2|ON,OFF|}', detail: 'Wait for condition' },
  { label: 'WAIT condition TIMEOUT', insert: 'WAIT ${1:DI[1]}=${2|ON,OFF|} TIMEOUT,LBL[${3:999}]', detail: 'Wait with timeout' },
  { label: 'WAIT time', insert: 'WAIT ${1:0.5}(sec)', detail: 'Wait fixed time' },
  { label: 'R[]', insert: 'R[${1}]', detail: 'Numeric register', suggest: true },
  { label: 'R[]=', insert: 'R[${1:1}]=${2:0}', detail: 'Register assignment' },
  { label: 'PR[]', insert: 'PR[${1}]', detail: 'Position register', suggest: true },
  { label: 'PR[]=', insert: 'PR[${1:1}]=${2|LPOS,JPOS,P[1],PR[1]|}', detail: 'Position register assignment' },
  { label: 'PR[]=LPOS', insert: 'PR[${1:1}]=LPOS', detail: 'Store current position' },
  { label: 'PR[,]=', insert: 'PR[${1:1},${2:1}]=${3:0}', detail: 'PR element assignment' },
  { label: 'SR[]=', insert: "SR[${1:1}]='${2:text}'", detail: 'String register assignment' },
  { label: 'DO[]=', insert: 'DO[${1:1}]=${2|ON,OFF,PULSE|}', detail: 'Digital output' },
  { label: 'RO[]=', insert: 'RO[${1:1}]=${2|ON,OFF|}', detail: 'Robot output' },
  { label: 'F[]=', insert: 'F[${1:1}]=(${2|ON,OFF|})', detail: 'Flag' },
  { label: 'GO[]=', insert: 'GO[${1:1}]=${2:0}', detail: 'Group output' },
  { label: 'UFRAME_NUM=', insert: 'UFRAME_NUM=${1:1}', detail: 'Active user frame' },
  { label: 'UTOOL_NUM=', insert: 'UTOOL_NUM=${1:1}', detail: 'Active tool frame' },
  { label: 'PAYLOAD[]', insert: 'PAYLOAD[${1:1}]', detail: 'Payload schedule' },
  { label: 'OVERRIDE=', insert: 'OVERRIDE=${1:100}%', detail: 'Speed override' },
  { label: 'TIMER[]=', insert: 'TIMER[${1:1}]=${2|START,STOP,RESET|}', detail: 'Timer' },
  { label: 'UALM[]', insert: 'UALM[${1:1}]', detail: 'User alarm' },
  { label: 'MESSAGE[]', insert: 'MESSAGE[${1:text}]', detail: 'Message' },
  { label: 'SKIP CONDITION', insert: 'SKIP CONDITION ${1:DI[1]}=${2|ON,OFF|}', detail: 'Skip condition' },
  { label: 'MONITOR', insert: 'MONITOR ${1:COND_PROG}', detail: 'Start condition monitor' },
  { label: 'MONITOR END', insert: 'MONITOR END ${1:COND_PROG}', detail: 'Stop condition monitor' },
  { label: 'COL DETECT ON', insert: 'COL DETECT ON', detail: 'Collision detect on' },
  { label: 'COL DETECT OFF', insert: 'COL DETECT OFF', detail: 'Collision detect off' },
  { label: 'COL GUARD ADJUST', insert: 'COL GUARD ADJUST ${1:100}', detail: 'Collision guard sensitivity' },
  { label: 'VISION RUN_FIND', insert: "VISION RUN_FIND '${1:PROCESS}'", detail: 'iRVision run find' },
  { label: 'VISION GET_OFFSET', insert: "VISION GET_OFFSET '${1:PROCESS}' VR[${2:1}] JMP LBL[${3:999}]", detail: 'iRVision get offset' },
  { label: 'ABORT', insert: 'ABORT', detail: 'Abort program' },
  { label: 'PAUSE', insert: 'PAUSE', detail: 'Pause program' },
  { label: 'END', insert: 'END', detail: 'End program' },
  { label: '! comment', insert: '!${1:comment}', detail: 'Comment' },
];

/**
 * What an operand position offers - anywhere past the start of the instruction. A data kind
 * inserts its brackets and leaves the caret inside them (the provider re-opens the list, so
 * the registers and their comments come straight up); `motionOnly` entries are the options
 * that only mean something on the end of a motion line.
 */
export const TP_OPERAND_COMPLETIONS: Array<{ label: string; insert: string; detail: string; suggest?: boolean; motionOnly?: boolean }> = [
  { label: 'FINE', insert: 'FINE', detail: 'Stop at the point', motionOnly: true },
  { label: 'CNT', insert: 'CNT${1:100}', detail: 'Round the corner (0-100)', motionOnly: true },
  { label: 'ACC', insert: 'ACC${1:100}', detail: 'Acceleration override', motionOnly: true },
  { label: 'Offset,PR[]', insert: 'Offset,PR[${1}]', detail: 'Position offset from a PR', suggest: true, motionOnly: true },
  { label: 'Tool_Offset,PR[]', insert: 'Tool_Offset,PR[${1}]', detail: 'Tool offset from a PR', suggest: true, motionOnly: true },
  { label: 'Skip,LBL[]', insert: 'Skip,LBL[${1}]', detail: 'Skip condition jump', suggest: true, motionOnly: true },
  ...['R', 'PR', 'SR', 'AR', 'DI', 'DO', 'RI', 'RO', 'GI', 'GO', 'AI', 'AO', 'UI', 'UO', 'SI', 'SO', 'F', 'M', 'TIMER'].map(k => ({ label: `${k}[]`, insert: k + '[${1}]', detail: DATA_KIND_DOCS[k]?.name ?? k, suggest: true })),
  { label: 'LBL[]', insert: 'LBL[${1}]', detail: 'Label', suggest: true },
  { label: 'JMP LBL[]', insert: 'JMP LBL[${1}]', detail: 'Jump', suggest: true },
  { label: 'CALL', insert: 'CALL ', detail: 'Call program - then pick it from the list', suggest: true },
  { label: 'ON', insert: 'ON', detail: 'Signal state' },
  { label: 'OFF', insert: 'OFF', detail: 'Signal state' },
  { label: 'PULSE', insert: 'PULSE,${1:0.5}sec', detail: 'Pulse an output' },
  { label: 'LPOS', insert: 'LPOS', detail: 'Current position, cartesian' },
  { label: 'JPOS', insert: 'JPOS', detail: 'Current position, joint' },
  { label: 'AND', insert: 'AND', detail: 'Logical and' },
  { label: 'OR', insert: 'OR', detail: 'Logical or' },
  { label: 'DIV', insert: 'DIV', detail: 'Integer division' },
  { label: 'MOD', insert: 'MOD', detail: 'Remainder' },
  { label: 'TIMEOUT,LBL[]', insert: 'TIMEOUT,LBL[${1}]', detail: 'WAIT timeout jump', suggest: true },
];

/**
 * Is the caret (at `col` of `lineText`) at a word where an operand could go? Returns the
 * word typed so far and whether the line is a motion line; undefined at the start of the
 * instruction (that is the instruction list's place), inside a comment, remark or string,
 * and inside a bracket - `R[1:gripper op` is a comment being typed, not an operand.
 */
// The generated catalog (FANUC manuals), after the hand-made entries so those keep their order:
// option instructions, option macros and FANUC programs start a line; motion options go in a
// motion line's tail; functions are operands.
{
  // the head of an entry: its first word / data kind ("PR" for PR[]=, "LINE" for LINE[<encoder>] ON)
  const headOf = (label: string) => label.toUpperCase().split(/[\s\[(=<,]/)[0];
  const handHeads = new Set([...TP_INSTRUCTION_COMPLETIONS, ...TP_OPERAND_COMPLETIONS].map(c => headOf(c.label)).filter(Boolean));
  const have = new Set([...TP_INSTRUCTION_COMPLETIONS, ...TP_OPERAND_COMPLETIONS].map(c => c.label.toUpperCase()));
  for (const c of CATALOG_COMPLETIONS) {
    // a hand-made entry already covers that instruction - keep the curated one, add only new syntax
    if (have.has(c.label.toUpperCase()) || handHeads.has(headOf(c.label))) continue;
    have.add(c.label.toUpperCase());
    if (c.kind === 'motion-option') TP_OPERAND_COMPLETIONS.push({ label: c.label, insert: c.insert, detail: c.detail, motionOnly: true });
    else if (c.kind === 'function') TP_OPERAND_COMPLETIONS.push({ label: c.label, insert: c.insert, detail: c.detail });
    else TP_INSTRUCTION_COMPLETIONS.push({ label: c.label, insert: c.insert, detail: c.detail });
  }
}

export function operandContext(lineText: string, col: number): { word: string; motion: boolean } | undefined {
  const before = lineText.slice(0, col);
  const head = /^\s*\d*:\s*|^\s*/.exec(before)![0];
  const body = before.slice(head.length);
  if (/^(!|\/\/|--eg)/.test(body)) return undefined;
  const m = /(?:^|[\s=<>(),+\-*/])([A-Za-z_]+)$/.exec(body);
  if (!m || m[1].length === body.length) return undefined;
  if (body.lastIndexOf('[') > body.lastIndexOf(']')) return undefined;
  if ((body.match(/'/g)?.length ?? 0) % 2 === 1 || (body.match(/"/g)?.length ?? 0) % 2 === 1) return undefined;
  return { word: m[1], motion: /^[JLCAS]\s/.test(body) };
}
