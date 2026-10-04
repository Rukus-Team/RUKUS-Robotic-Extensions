/**
 * KAREL built-in routines: signature + short description for hover, completion
 * and signature help. Curated from the KAREL Reference Manual.
 */
import { KAREL_EV_NAMES } from './evNames';

export interface KBuiltin { name: string; sig: string; doc: string; ret?: string }

const B: KBuiltin[] = [];
function b(name: string, sig: string, doc: string, ret?: string) { B.push({ name, sig, doc, ret }); }

// Math
b('ABS', 'ABS(x : INTEGER|REAL)', 'Absolute value.', 'INTEGER|REAL');
b('ROUND', 'ROUND(x : REAL)', 'Rounds a REAL to the nearest INTEGER.', 'INTEGER');
b('TRUNC', 'TRUNC(x : REAL)', 'Truncates a REAL toward zero to an INTEGER.', 'INTEGER');
b('SQRT', 'SQRT(x : REAL)', 'Square root.', 'REAL');
b('SIN', 'SIN(deg : REAL)', 'Sine of an angle in degrees.', 'REAL');
b('COS', 'COS(deg : REAL)', 'Cosine of an angle in degrees.', 'REAL');
b('TAN', 'TAN(deg : REAL)', 'Tangent of an angle in degrees.', 'REAL');
b('ASIN', 'ASIN(x : REAL)', 'Arcsine in degrees.', 'REAL');
b('ACOS', 'ACOS(x : REAL)', 'Arccosine in degrees.', 'REAL');
b('ATAN2', 'ATAN2(y : REAL; x : REAL)', 'Arctangent of y/x in degrees, quadrant-correct.', 'REAL');
b('EXP', 'EXP(x : REAL)', 'e raised to x.', 'REAL');
b('LN', 'LN(x : REAL)', 'Natural logarithm.', 'REAL');

// Strings
b('CHR', 'CHR(code : INTEGER)', 'Single-character string for an ASCII code.', 'STRING');
b('ORD', 'ORD(str : STRING; index : INTEGER)', 'ASCII code of the character at index (1-based).', 'INTEGER');
b('STR_LEN', 'STR_LEN(str : STRING)', 'Length of a string.', 'INTEGER');
b('SUB_STR', 'SUB_STR(src : STRING; start : INTEGER; length : INTEGER)', 'Substring starting at start (1-based) of the given length.', 'STRING');
b('INDEX', 'INDEX(src : STRING; search : STRING)', 'Position of search inside src, or 0 if absent.', 'INTEGER');
b('CNV_INT_STR', 'CNV_INT_STR(src : INTEGER; length : INTEGER; base : INTEGER; VAR target : STRING)', 'Converts an INTEGER to a string. length = minimum width (0 = no padding), base 2–16 (0 = decimal).');
b('CNV_REAL_STR', 'CNV_REAL_STR(src : REAL; length : INTEGER; num_digits : INTEGER; VAR target : STRING)', 'Converts a REAL to a string with the given width and decimal digits.');
b('CNV_STR_INT', 'CNV_STR_INT(src : STRING; VAR target : INTEGER)', 'Converts a string to INTEGER. target is UNINIT on failure.');
b('CNV_STR_REAL', 'CNV_STR_REAL(src : STRING; VAR target : REAL)', 'Converts a string to REAL. target is UNINIT on failure.');
b('CNV_CONF_STR', 'CNV_CONF_STR(src : CONFIG; VAR target : STRING)', 'Converts a CONFIG to its string form, e.g. "N U T, 0, 0, 0".');
b('CNV_STR_CONF', 'CNV_STR_CONF(src : STRING; VAR target : CONFIG; VAR status : INTEGER)', 'Converts a configuration string to a CONFIG.');
b('CNV_TIME_STR', 'CNV_TIME_STR(time : INTEGER; VAR target : STRING)', 'Converts a controller time INTEGER to "DD-MMM-YY HH:MM".');
b('CNV_STR_TIME', 'CNV_STR_TIME(src : STRING; VAR time : INTEGER)', 'Converts a time string to the packed INTEGER form.');

// Registers
b('GET_REG', 'GET_REG(reg_no : INTEGER; VAR real_flag : BOOLEAN; VAR int_value : INTEGER; VAR real_value : REAL; VAR status : INTEGER)', 'Reads numeric register R[reg_no]. real_flag tells which of int_value/real_value holds the value.');
b('SET_INT_REG', 'SET_INT_REG(reg_no : INTEGER; int_value : INTEGER; VAR status : INTEGER)', 'Writes an INTEGER into R[reg_no].');
b('SET_REAL_REG', 'SET_REAL_REG(reg_no : INTEGER; real_value : REAL; VAR status : INTEGER)', 'Writes a REAL into R[reg_no].');
b('GET_REG_CMT', 'GET_REG_CMT(reg_no : INTEGER; VAR comment : STRING; VAR status : INTEGER)', 'Reads the comment of R[reg_no].');
b('SET_REG_CMT', 'SET_REG_CMT(reg_no : INTEGER; comment : STRING; VAR status : INTEGER)', 'Sets the comment of R[reg_no] (max 16 chars).');
b('GET_POS_REG', 'GET_POS_REG(reg_no : INTEGER; VAR status : INTEGER <; group_no : INTEGER>)', 'Returns PR[reg_no] as XYZWPREXT.', 'XYZWPREXT');
b('SET_POS_REG', 'SET_POS_REG(reg_no : INTEGER; pos : XYZWPREXT; VAR status : INTEGER <; group_no : INTEGER>)', 'Stores a cartesian position into PR[reg_no].');
b('GET_JPOS_REG', 'GET_JPOS_REG(reg_no : INTEGER; VAR status : INTEGER <; group_no : INTEGER>)', 'Returns PR[reg_no] as JOINTPOS.', 'JOINTPOS');
b('SET_JPOS_REG', 'SET_JPOS_REG(reg_no : INTEGER; jpos : JOINTPOS; VAR status : INTEGER <; group_no : INTEGER>)', 'Stores a joint position into PR[reg_no].');
b('SET_EPOS_REG', 'SET_EPOS_REG(reg_no : INTEGER; pos : XYZWPREXT; VAR status : INTEGER <; group_no : INTEGER>)', 'Stores an XYZWPREXT (with extended axes) into PR[reg_no].');
b('POS_REG_TYPE', 'POS_REG_TYPE(reg_no : INTEGER; group_no : INTEGER; VAR posn_type : INTEGER; VAR num_axes : INTEGER; VAR status : INTEGER)', 'Tells whether PR[reg_no] is cartesian (2 = XYZWPR, 6 = XYZWPREXT) or joint (9 = JOINTPOS).');
b('CLR_POS_REG', 'CLR_POS_REG(register_no : INTEGER; group_no : INTEGER; VAR status : INTEGER)', 'Removes all data for the specified group in the specified position register.');
b('GET_PREG_CMT', 'GET_PREG_CMT(reg_no : INTEGER; VAR comment : STRING; VAR status : INTEGER)', 'Reads the comment of PR[reg_no].');
b('SET_PREG_CMT', 'SET_PREG_CMT(reg_no : INTEGER; comment : STRING; VAR status : INTEGER)', 'Sets the comment of PR[reg_no].');
b('GET_STR_REG', 'GET_STR_REG(reg_no : INTEGER; VAR value : STRING; VAR status : INTEGER)', 'Reads string register SR[reg_no].');
b('SET_STR_REG', 'SET_STR_REG(reg_no : INTEGER; value : STRING; VAR status : INTEGER)', 'Writes string register SR[reg_no].');
b('GET_SREG_CMT', 'GET_SREG_CMT(reg_no : INTEGER; VAR comment : STRING; VAR status : INTEGER)', 'Reads the comment of SR[reg_no].');
b('SET_SREG_CMT', 'SET_SREG_CMT(reg_no : INTEGER; comment : STRING; VAR status : INTEGER)', 'Sets the comment of SR[reg_no].');

// Variables
b('GET_VAR', 'GET_VAR(VAR entry : INTEGER; prog_name : STRING; var_name : STRING; VAR value : <any>; VAR status : INTEGER)', 'Reads a KAREL or system variable by name. prog_name "*SYSTEM*" for $ variables, "" for the current program. entry caches the lookup.');
b('SET_VAR', 'SET_VAR(VAR entry : INTEGER; prog_name : STRING; var_name : STRING; value : <any>; VAR status : INTEGER)', 'Writes a KAREL or system variable by name.');
b('VAR_INFO', 'VAR_INFO(prog_name : STRING; var_name : STRING; VAR uninit_b : BOOLEAN; VAR type_nam : STRING; VAR dims : ARRAY[3] OF INTEGER; VAR type_value : INTEGER; VAR status : INTEGER; VAR slen : INTEGER)', 'Allows a KAREL program to determine data type and numerical information regarding internal or external program variables.');
b('VAR_LIST', 'VAR_LIST(prog_name : STRING; var_name : STRING; var_type : INTEGER; n_skip : INTEGER; format : INTEGER; VAR ary_nam : ARRAY of STRING; VAR n_vars : INTEGER; VAR status : INTEGER)', 'Locates variables in the specified KAREL program with the specified name and data type.');
b('CREATE_VAR', 'CREATE_VAR(var_prog_nam : STRING; var_nam : STRING; typ_prog_nam : STRING; type_nam : STRING; group_num : INTEGER; inner_dim : INTEGER; mid_dim : INTEGER; outer_dim : INTEGER; VAR status : INTEGER; [mem_pool : INTEGER])', 'Creates the specified KAREL variable.');
b('RENAME_VAR', 'RENAME_VAR(prog_name : STRING; old_name : STRING; new_name : STRING; VAR status : INTEGER)', 'Renames a variable.');
b('UNINIT', 'UNINIT(variable)', 'TRUE if the variable is uninitialised.', 'BOOLEAN');
b('ARRAY_LEN', 'ARRAY_LEN(array)', 'Number of elements of an array.', 'INTEGER');

// Positions
b('CURPOS', 'CURPOS(axis_limit_mask : INTEGER; VAR ovr_ck : INTEGER <; group_no : INTEGER>)', 'Current cartesian position of the TCP in the current user frame.', 'XYZWPREXT');
b('CURJPOS', 'CURJPOS(axis_limit_mask : INTEGER; VAR ovr_ck : INTEGER <; group_no : INTEGER>)', 'Current joint position.', 'JOINTPOS');
b('POS', 'POS(x, y, z, w, p, r : REAL; c : CONFIG)', 'Builds an XYZWPR from components.', 'XYZWPR');
b('UNPOS', 'UNPOS(posn : POSITION; VAR x, y, z, w, p, r : REAL; VAR c : CONFIG)', 'Splits a position into components.');
b('JOINT2POS', 'JOINT2POS(jpos : JOINTPOS; uframe : POSITION; utool : POSITION; config_ref : INTEGER; VAR posn : XYZWPREXT; VAR wjnt_cfg : CONFIG; VAR ext_ang : ARRAY OF REAL; VAR status : INTEGER)', 'Forward kinematics: joint → cartesian.');
b('POS2JOINT', 'POS2JOINT(ref_jnt : JOINTPOS; in_pos : POSITION; uframe : POSITION; utool : POSITION; config_ref : INTEGER; wjnt_cfg : CONFIG; ext_ang : ARRAY OF REAL; VAR out_jnt : JOINTPOS; VAR status : INTEGER)', 'This routine is used to convert Cartesian positions (in_pos) to joint angles (out_jnt) by calling the inverse kinematics routine.');
b('FRAME', 'FRAME(pos1, pos2, pos3 : POSITION <; pos4 : POSITION>)', 'Builds a frame from three (or four) taught points: origin, +X, XY-plane.', 'POSITION');
b('INV', 'INV(posn : POSITION)', 'Inverse of a position/frame.', 'POSITION');
b('IN_RANGE', 'IN_RANGE(posn : POSITION)', 'TRUE if the position is reachable.', 'BOOLEAN');
b('J_IN_RANGE', 'J_IN_RANGE(jpos : JOINTPOS)', 'TRUE if the joint position is within limits.', 'BOOLEAN');
b('CHECK_EPOS', 'CHECK_EPOS(epos : XYZWPREXT; uframe : POSITION; utool : POSITION; VAR status : INTEGER <; group_no : INTEGER>)', 'Checks that a position is reachable in the given frames.');
b('SET_PERCH', 'SET_PERCH(perch_no : INTEGER; jpos : JOINTPOS; VAR status : INTEGER)', 'Sets a reference (perch) position.');
b('GET_POS_TYP', 'GET_POS_TYP(open_id : INTEGER; position_no : INTEGER; group_no : INTEGER; VAR posn_typ : INTEGER; VAR num_axs : INTEGER; VAR status : INTEGER)', 'Gets the position representation of the specified position in the specified teach pendant program.');
b('CNV_JPOS_REL', 'CNV_JPOS_REL(jpos : JOINTPOS; VAR real_array : ARRAY OF REAL; VAR status : INTEGER)', 'Joint position → array of joint angles.');
b('CNV_REL_JPOS', 'CNV_REL_JPOS(real_array : ARRAY OF REAL; VAR jpos : JOINTPOS; VAR status : INTEGER)', 'Array of joint angles → joint position.');

// TP program access
b('OPEN_TPE', 'OPEN_TPE(prog_name : STRING; open_mode : INTEGER; reject_mode : INTEGER; VAR open_id : INTEGER; VAR status : INTEGER)', 'Opens a TP program. open_mode: TPE_RDACC=1, TPE_RWACC=2. reject_mode: TPE_RDREJ=1, TPE_WRTREJ=2, TPE_ALLREJ=3, TPE_NOREJ=0.');
b('CLOSE_TPE', 'CLOSE_TPE(open_id : INTEGER; VAR status : INTEGER)', 'Closes a TP program opened with OPEN_TPE.');
b('CREATE_TPE', 'CREATE_TPE(prog_name : STRING; prog_type : INTEGER; VAR status : INTEGER)', 'Creates a TP program. prog_type: 1 = normal, 2 = macro, 3 = condition.');
b('DELETE_TPE', 'DELETE_TPE(prog_name : STRING; VAR status : INTEGER)', 'Deletes a TP program.');
b('COPY_TPE', 'COPY_TPE(from_prog : STRING; to_prog : STRING; overwrite_sw : BOOLEAN; VAR status : INTEGER)', 'Copies one teach pendant program to another teach pendant program.');
b('RENAME_TPE', 'RENAME_TPE(old_name : STRING; new_name : STRING; VAR status : INTEGER)', 'Renames a TP program.');
b('SELECT_TPE', 'SELECT_TPE(prog_name : STRING; VAR status : INTEGER)', 'Selects a TP program on the pendant.');
b('GET_ATTR_PRG', 'GET_ATTR_PRG(prog_name : STRING; attr_number : INTEGER; VAR int_value : INTEGER; VAR string_value : STRING; VAR status : INTEGER)', 'Reads a program attribute (AT_PROG_TYPE=1, AT_PROG_NAME=2, AT_OWNER=3, AT_COMMENT=4, AT_PROG_SIZE=5, AT_CREATE_TIME=6, AT_MODIFY_TIME=7, AT_FILE_NAME=8, AT_PROTECT=9, AT_TASK_ATTR=10, AT_TASK_MASK=11, AT_TASK_GROUP=12).');
b('SET_ATTR_PRG', 'SET_ATTR_PRG(prog_name : STRING; attr_number : INTEGER; int_value : INTEGER; string_value : STRING; VAR status : INTEGER)', 'Sets a program attribute.');
b('GET_POS_TPE', 'GET_POS_TPE(open_id : INTEGER; position_no : INTEGER; VAR status : INTEGER; group_no : INTEGER)', 'Gets an XYZWPREXT value from the specified position in the specified teach pendant program.', 'XYZWPREXT');
b('SET_POS_TPE', 'SET_POS_TPE(open_id : INTEGER; position_no : INTEGER; posn : XYZWPREXT; VAR status : INTEGER <; group_no : INTEGER>)', 'Writes position P[position_no] of an open TP program.');
b('GET_JPOS_TPE', 'GET_JPOS_TPE(open_id : INTEGER; position_no : INTEGER; VAR status : INTEGER <; group_no : INTEGER>)', 'Reads a joint position from an open TP program.', 'JOINTPOS');
b('SET_JPOS_TPE', 'SET_JPOS_TPE(open_id : INTEGER; position_no : INTEGER; jpos : JOINTPOS; VAR status : INTEGER <; group_no : INTEGER>)', 'Writes a joint position into an open TP program.');
b('SET_EPOS_TPE', 'SET_EPOS_TPE(open_id : INTEGER; position_no : INTEGER; posn : XYZWPREXT; VAR status : INTEGER <; group_no : INTEGER>)', 'Writes an XYZWPREXT into an open TP program.');
b('AVL_POS_NUM', 'AVL_POS_NUM(open_id : INTEGER; VAR position_no : INTEGER; VAR status : INTEGER)', 'Next unused position number in an open TP program.');
b('GET_TPE_PRM', 'GET_TPE_PRM(param_no : INTEGER; VAR data_type : INTEGER; VAR int_value : INTEGER; VAR real_value : REAL; VAR str_value : STRING; VAR status : INTEGER)', 'Reads argument param_no passed by the calling TP program (AR[n]).');
b('GET_TPE_CMT', 'GET_TPE_CMT(open_id : INTEGER; position_no : INTEGER; VAR comment : STRING; VAR status : INTEGER)', 'Reads the comment of a TP position.');
b('SET_TPE_CMT', 'SET_TPE_CMT(open_id : INTEGER; position_no : INTEGER; comment : STRING; VAR status : INTEGER)', 'Sets the comment of a TP position.');
b('SET_TRNS_TPE', 'SET_TRNS_TPE(open_id : INTEGER; position_no : INTEGER; posn : POSITION; VAR status : INTEGER)', 'Stores a POSITION value within the specified position in the specified teach pendant program.');
b('CALL_PROG', 'CALL_PROG(prog_name : STRING; prog_index : INTEGER)', 'Calls a TP or KAREL program by name (waits for it to finish).');
b('CALL_PROGLIN', 'CALL_PROGLIN(prog_name : STRING; prog_line : INTEGER; prog_index : INTEGER; pause_entry : BOOLEAN)', 'Calls a TP program starting at a given line.');
b('CURR_PROG', 'CURR_PROG()', 'Returns the name of the program currently being executed.', 'STRING[12]');
b('PROG_LIST', 'PROG_LIST(prog_name : STRING; prog_type : INTEGER; n_skip : INTEGER; format : INTEGER; VAR ary_name : ARRAY OF STRING; VAR n_progs : INTEGER; VAR status : INTEGER; f_index : INTEGER)', 'Returns a list of program names.');
b('PROG_BACKUP', 'PROG_BACKUP(file_spec : STRING; prog_type : INTEGER; max_size : INTEGER; write_prot : BOOLEAN; VAR status : INTEGER)', 'Saves the specified program and all called programs from execution memory to a storage device. If the called programs call other programs they will be saved recursively. You can specify that any associated program variables be saved.');
b('PROG_CLEAR', 'PROG_CLEAR(prog_name : STRING; prog_type : INTEGER; VAR status : INTEGER)', 'Clear the specified program and all called programs from execution memory. If the called programs call other programs they will be cleared recursively. You can specify that any associated program variables also be cleared. Variables which are referenced from other programs will not be cleared.');
b('PROG_RESTORE', 'PROG_RESTORE(file_spec : STRING; VAR status : INTEGER)', 'Restores (loads) the specified program and all called programs into execution memory. If the called programs call other programs they will be loaded recursively. Any associated program variables will also be loaded if the VR files exist.');
b('LOAD', 'LOAD(file_spec : STRING; access : INTEGER; VAR status : INTEGER)', 'Loads a .pc/.tp/.vr file into memory.');
b('LOAD_STATUS', 'LOAD_STATUS(prog_name : STRING; VAR loaded : BOOLEAN; VAR initialized : BOOLEAN)', 'Whether a program is loaded / its variables initialised.');
b('SAVE', 'SAVE(prog_name : STRING; file_spec : STRING; VAR status : INTEGER)', 'Saves program variables to a .vr file.');
b('SAVE_DRAM', 'SAVE_DRAM(prog_nam : STRING; VAR status : INTEGER)', 'Saves the RAM variable content to FlashROM.');
b('CLEAR', 'CLEAR(prog_name : STRING; VAR status : INTEGER)', 'Clears a program and its variables from memory.');

// Tasks
b('RUN_TASK', 'RUN_TASK(prog_name : STRING; line_number : INTEGER; pause_on_sft : BOOLEAN; tp_motion_enable : BOOLEAN; lock_mask : INTEGER; VAR status : INTEGER)', 'Starts a program as a new task.');
b('ABORT_TASK', 'ABORT_TASK(task_name : STRING; force_sev : BOOLEAN; abort_paused : BOOLEAN; VAR status : INTEGER)', 'Aborts a running task.');
b('PAUSE_TASK', 'PAUSE_TASK(task_name : STRING; force_sev : BOOLEAN; pause_all : BOOLEAN; VAR status : INTEGER)', 'Pauses a task.');
b('CONT_TASK', 'CONT_TASK(task_name : STRING; VAR status : INTEGER)', 'Continues a paused task.');
b('GET_TSK_INFO', 'GET_TSK_INFO(task_name : STRING; task_no : INTEGER; attribute : INTEGER; VAR value_int : INTEGER; VAR value_str : STRING; VAR status : INTEGER)', 'Task attributes: TSK_STATUS=1, TSK_PRIORITY=2, TSK_TIMESLIC=3, TSK_PROGNAME=4, TSK_ROUTNAME=5, TSK_LINENUM=6, TSK_TRACE=7, TSK_HOLDCOND=8, TSK_NOABORT=9, TSK_NOPAUSE=10, TSK_NOBUSY=11, TSK_TPMOTN=12, TSK_LOCKGRP=13, TSK_PARENT=14, TSK_STEP=15, TSK_MCTL=16, TSK_NAME=17, TSK_PAUSESFT=18, TSK_NOMSG=19.');
b('SET_TSK_ATTR', 'SET_TSK_ATTR(task_name : STRING; attribute : INTEGER; value : INTEGER; VAR status : INTEGER)', 'Set the value of the specified running task attribute.');
b('SET_TSK_NAME', 'SET_TSK_NAME(old_name : STRING; new_name : STRING; VAR status : INTEGER)', 'Set the name of the specified task.');
b('MOTION_CTL', 'MOTION_CTL(group_mask : INTEGER)', 'Determines whether the KAREL program has motion control for the specified group of axes.', 'BOOLEAN');
b('LOCK_GROUP', 'LOCK_GROUP(group_mask : INTEGER; VAR status : INTEGER)', 'Locks motion groups for this task.');
b('UNLOCK_GROUP', 'UNLOCK_GROUP(group_mask : INTEGER; VAR status : INTEGER)', 'Unlocks motion groups.');
b('CNCL_STP_MTN', 'CNCL_STP_MTN', 'Cancels all stopped motion.');

// Semaphores / queues
b('CLEAR_SEMA', 'CLEAR_SEMA(semaphore_no : INTEGER)', 'Sets a semaphore count to zero.');
b('POST_SEMA', 'POST_SEMA(semaphore_no : INTEGER)', 'Increments a semaphore.');
b('PEND_SEMA', 'PEND_SEMA(semaphore_no : INTEGER; max_time : INTEGER; VAR time_out : BOOLEAN)', 'Waits for a semaphore (ms timeout, -1 forever).');
b('SEMA_COUNT', 'SEMA_COUNT(semaphore_no : INTEGER)', 'Current count of a semaphore.', 'INTEGER');
b('INIT_QUEUE', 'INIT_QUEUE(VAR queue : QUEUE_TYPE)', 'Initialises a queue.');
b('APPEND_QUEUE', 'APPEND_QUEUE(value : INTEGER; VAR queue : QUEUE_TYPE; VAR queue_data : ARRAY OF INTEGER; VAR sequence_no : INTEGER; VAR status : INTEGER)', 'Appends to a queue.');
b('GET_QUEUE', 'GET_QUEUE(VAR queue : QUEUE_TYPE; VAR queue_data : ARRAY OF INTEGER; VAR value : INTEGER; VAR sequence_no : INTEGER; VAR status : INTEGER)', 'Removes the oldest entry from a queue.');
b('DELETE_QUEUE', 'DELETE_QUEUE(sequence_no : INTEGER; VAR queue : QUEUE_TYPE; VAR queue_data : ARRAY OF INTEGER; VAR status : INTEGER)', 'Deletes an entry from a queue.');
b('INSERT_QUEUE', 'INSERT_QUEUE(value : INTEGER; sequence_no : INTEGER; VAR queue : QUEUE_TYPE; VAR queue_data : ARRAY OF INTEGER; VAR status : INTEGER)', 'Inserts before a sequence number.');
b('MODIFY_QUEUE', 'MODIFY_QUEUE(sequence_no : INTEGER; value : INTEGER; VAR queue : QUEUE_TYPE; VAR queue_data : ARRAY OF INTEGER; VAR status : INTEGER)', 'Modifies an entry in a queue.');
b('COPY_QUEUE', 'COPY_QUEUE(VAR queue : QUEUE_TYPE; VAR queue_data : ARRAY OF INTEGER; sequence_no : INTEGER; n_skip : INTEGER; VAR out_data : ARRAY OF INTEGER; VAR n_got : INTEGER; VAR status : INTEGER)', 'Copies entries out of a queue.');

// I/O
b('GET_PORT_VAL', 'GET_PORT_VAL(port_type : INTEGER; port_no : INTEGER; VAR value : INTEGER; VAR status : INTEGER)', 'Reads an I/O port by type code (io_din=1, io_dout=2, io_anin=3, io_anout=4, io_rdi=8, io_rdo=9, io_opin=11, io_opout=12, io_gpin=18, io_gpout=19, io_uopin=20, io_uopout=21, io_flag=35).');
b('SET_PORT_VAL', 'SET_PORT_VAL(port_type : INTEGER; port_no : INTEGER; value : INTEGER; VAR status : INTEGER)', 'Writes an I/O port.');
b('GET_PORT_CMT', 'GET_PORT_CMT(port_type : INTEGER; port_no : INTEGER; VAR comment : STRING; VAR status : INTEGER)', 'Reads an I/O comment.');
b('SET_PORT_CMT', 'SET_PORT_CMT(port_type : INTEGER; port_no : INTEGER; comment : STRING; VAR status : INTEGER)', 'Sets an I/O comment.');
b('GET_PORT_ASG', 'GET_PORT_ASG(log_port_type : INTEGER; log_port_no : INTEGER; VAR rack_no : INTEGER; VAR slot_no : INTEGER; VAR phy_port_type : INTEGER; VAR phy_port_no : INTEGER; VAR n_ports : INTEGER; VAR status : INTEGER)', 'Reads the rack/slot/start assignment of a logical port.');
b('SET_PORT_ASG', 'SET_PORT_ASG(log_port_type : INTEGER; log_port_no : INTEGER; rack_no : INTEGER; slot_no : INTEGER; phy_port_type : INTEGER; phy_port_no : INTEGER; n_ports : INTEGER; VAR status : INTEGER)', 'Assigns logical ports to a rack/slot.');
b('GET_PORT_ATR', 'GET_PORT_ATR(port_id : INTEGER; atr_type : INTEGER; VAR atr_value : INTEGER)', 'Reads a port attribute.', 'INTEGER');
b('SET_PORT_ATR', 'SET_PORT_ATR(port_id : INTEGER; atr_type : INTEGER; atr_value : INTEGER)', 'Sets a port attribute.', 'INTEGER');
b('GET_PORT_MOD', 'GET_PORT_MOD(port_type : INTEGER; port_no : INTEGER; VAR mode : INTEGER; VAR status : INTEGER)', 'Reads port mode (complementary, inverse, etc.).');
b('SET_PORT_MOD', 'SET_PORT_MOD(port_type : INTEGER; port_no : INTEGER; mode : INTEGER; VAR status : INTEGER)', 'Sets port mode.');
b('GET_PORT_SIM', 'GET_PORT_SIM(port_type : INTEGER; port_no : INTEGER; VAR simulated : BOOLEAN; VAR status : INTEGER)', 'Whether a port is simulated.');
b('SET_PORT_SIM', 'SET_PORT_SIM(port_type : INTEGER; port_no : INTEGER; simulated : BOOLEAN; VAR status : INTEGER)', 'Simulates / unsimulates a port.');
b('CLR_PORT_SIM', 'CLR_PORT_SIM(port_type : INTEGER; port_no : INTEGER; VAR status : INTEGER)', 'Clears simulation on a port.');
b('IO_MOD_TYPE', 'IO_MOD_TYPE(port_type : INTEGER; port_no : INTEGER; VAR mod_type : INTEGER; VAR status : INTEGER)', 'I/O module type of a port.');
b('CLR_IO_STAT', 'CLR_IO_STAT(file_var : FILE)', 'Clears the I/O status of a file.');
b('IO_STATUS', 'IO_STATUS(file_var : FILE)', 'Status of the last I/O operation on a file (0 = OK).', 'INTEGER');

// Files
b('OPEN FILE', "OPEN FILE file_var ('RW'|'RO'|'AP'|'UD', 'device:\\file.ext')", 'Statement: opens a file. Check IO_STATUS afterwards.');
b('BYTES_AHEAD', 'BYTES_AHEAD(file_id : FILE; VAR n_bytes : INTEGER; VAR status : INTEGER)', 'Bytes available to read on a communication port.');
b('BYTES_LEFT', 'BYTES_LEFT(file_id : FILE)', 'Bytes left in the current record.', 'INTEGER');
b('GET_FILE_POS', 'GET_FILE_POS(file_id : FILE)', 'Current file position.', 'INTEGER');
b('SET_FILE_POS', 'SET_FILE_POS(file_id : FILE; new_file_pos : INTEGER; VAR status : INTEGER)', 'Seeks in a file.');
b('SET_FILE_ATR', 'SET_FILE_ATR(file_id : FILE; atr_type : INTEGER <; atr_value : INTEGER>)', 'Sets file attributes (ATR_IA, ATR_PASSALL, ATR_FIELD, ATR_EOL, ATR_UF, ATR_TIMEOUT, ATR_PAGE...).');
b('COPY_FILE', 'COPY_FILE(from_file : STRING; to_file : STRING; overwrite_sw : BOOLEAN; nowait_sw : BOOLEAN; VAR status : INTEGER)', 'Copies a file.');
b('DELETE_FILE', 'DELETE_FILE(file_spec : STRING; nowait_sw : BOOLEAN; VAR status : INTEGER)', 'Deletes a file.');
b('RENAME_FILE', 'RENAME_FILE(old_file : STRING; new_file : STRING; nowait_sw : BOOLEAN; VAR status : INTEGER)', 'Renames a file.');
b('MOVE_FILE', 'MOVE_FILE(file_spec : STRING; VAR status : INTEGER)', 'Moves the specified file from one memory file device to another.');
b('FILE_LIST', 'FILE_LIST(file_spec : STRING; n_skip : INTEGER; format : INTEGER; VAR ary_nam : ARRAY OF STRING; VAR n_files : INTEGER; VAR status : INTEGER)', 'Lists files matching a spec.');
b('COMPARE_FILE', 'COMPARE_FILE(filea : STRING; fileb : STRING; VAR result_file : FILE; ascii_flag : BOOLEAN; VAR diff_count : INTEGER; VAR status : INTEGER)', 'Compares the contents of one file with another file.');
b('PRINT_FILE', 'PRINT_FILE(file_spec : STRING; nowait_sw : BOOLEAN; VAR status : INTEGER)', 'Prints a file.');
b('MOUNT_DEV', 'MOUNT_DEV(device : STRING; VAR status : INTEGER)', 'Mounts a device.');
b('DISMOUNT_DEV', 'DISMOUNT_DEV(device : STRING; VAR status : INTEGER)', 'Dismounts a device.');
b('FORMAT_DEV', 'FORMAT_DEV(device : STRING; volume_name : STRING; nowait_sw : BOOLEAN; VAR status : INTEGER)', 'Formats a device.');
b('PURGE_DEV', 'PURGE_DEV(device : STRING; VAR status : INTEGER)', 'Purges deleted files from a device.');
b('VOL_SPACE', 'VOL_SPACE(device : STRING; VAR total : INTEGER; VAR free : INTEGER; VAR volume : STRING)', 'Returns the total bytes, free bytes, and volume name for the specified device.');
b('DOSFILE_INF', 'DOSFILE_INF(file_spec : STRING; item : INTEGER; VAR value : STRING; VAR status : INTEGER)', 'File information (size, date...).');
b('CHECK_NAME', 'CHECK_NAME(name : STRING; VAR status : INTEGER)', 'Validates a program/file name.');

// Display / dictionaries
b('WRITE', "WRITE <file_var> (item, item, ..., CR)", 'Statement: writes items to a file or device (TPDISPLAY, TPERROR, TPPROMPT, CRTPROMPT...). CR ends the line.');
b('READ', 'READ <file_var> (item, item, ...)', 'Statement: reads items from a file or device.');
b('FORCE_SPMENU', 'FORCE_SPMENU(device_code : INTEGER; spmenu_id : INTEGER; screen_no : INTEGER)', 'Forces the pendant/CRT to a menu (tp_panel=1; SPI_TPUSER=15 user screen, SPI_TPALARM=8 alarms...).');
b('ACT_SCREEN', 'ACT_SCREEN(screen_name : STRING; VAR old_screen_name : STRING; VAR status : INTEGER)', 'Activates a user screen.');
b('DEF_SCREEN', 'DEF_SCREEN(screen_name : STRING; disp_dev_nam : STRING; VAR status : INTEGER)', 'Defines a screen.');
b('DEF_WINDOW', 'DEF_WINDOW(window_name : STRING; disp_dev_nam : STRING; n_rows : INTEGER; n_cols : INTEGER; VAR status : INTEGER)', 'Defines a window.');
b('ATT_WINDOW_D', 'ATT_WINDOW_D(window_name : STRING; disp_dev_nam : STRING; row : INTEGER; col : INTEGER; VAR screen_name : STRING; VAR status : INTEGER)', 'Attach a window to the screen on a display device.');
b('ATT_WINDOW_S', 'ATT_WINDOW_S(window_name : STRING; screen_name : STRING; row : INTEGER; col : INTEGER; VAR status : INTEGER)', 'Attaches a window to a screen (stacked).');
b('DET_WINDOW', 'DET_WINDOW(window_name : STRING; screen_name : STRING; VAR status : INTEGER)', 'Detaches a window.');
b('SET_CURSOR', 'SET_CURSOR(file_id : FILE; row : INTEGER; col : INTEGER; VAR status : INTEGER)', 'Positions the cursor in a window.');
b('ADD_DICT', 'ADD_DICT(file_name : STRING; dict_name : STRING; lang_name : STRING; add_option : INTEGER; VAR status : INTEGER)', 'Loads a dictionary (.tx compiled with kcl).');
b('REMOVE_DICT', 'REMOVE_DICT(dict_name : STRING; lang_name : STRING; VAR status : INTEGER)', 'Unloads a dictionary.');
b('CHECK_DICT', 'CHECK_DICT(dict_name : STRING; element_no : INTEGER; VAR status : INTEGER)', 'Checks that a dictionary element exists.');
b('READ_DICT', 'READ_DICT(dict_name : STRING; element_no : INTEGER; VAR ksta : ARRAY OF STRING; first_line : INTEGER; VAR last_line : INTEGER; VAR status : INTEGER)', 'Reads information from a dictionary.');
b('READ_DICT_V', 'READ_DICT_V(dict_name : STRING; element_no : INTEGER; VAR ary_str : ARRAY OF STRING; ary_index : INTEGER; VAR status : INTEGER)', 'Reads a dictionary element with variable substitution.');
b('WRITE_DICT', 'WRITE_DICT(file_var : FILE; dict_name : STRING; element_no : INTEGER; VAR status : INTEGER)', 'Writes a dictionary element to a file/window.');
b('WRITE_DICT_V', 'WRITE_DICT_V(file_var : FILE; dict_name : STRING; element_no : INTEGER; VAR value_array : ARRAY OF ...; VAR status : INTEGER)', 'Writes a dictionary element with substituted values.');
b('DISCTRL_ALPH', 'DISCTRL_ALPH(window_name : STRING; row : INTEGER; col : INTEGER; str : STRING; dict_name : STRING; dict_ele : INTEGER; VAR term_char : INTEGER; VAR status : INTEGER)', 'Displays and controls alphanumeric string entry in a specified window.');
b('DISCTRL_FORM', 'DISCTRL_FORM(dict_name : STRING; ele_number : INTEGER; value_array : ARRAY OF STRING; inactive_array : ARRAY OF BOOLEAN; VAR change_array : ARRAY OF BOOLEAN; term_mask : INTEGER; def_item : INTEGER; VAR term_char : INTEGER; VAR status : INTEGER)', 'Displays and controls a form on the teach pendant or CRT/KB screen.');
b('DISCTRL_LIST', 'DISCTRL_LIST(file__var : FILE; display_data : DISP_DAT_T; list_data : ARRAY OF STRING; action : INTEGER; VAR status : INTEGER)', 'Displays and controls cursor movement and selection in a list in a specified window.');
b('DISCTRL_TBL', 'DISCTRL_TBL(dict_name : STRING; ele_number : INTEGER; num_rows : INTEGER; num_columns : INTEGER; col_data : ARRAY OF COL_DESC_T; inact_array : ARRAY OF BOOLEAN; VAR change_array : ARRAY OF BOOLEAN; def_item : INTEGER; VAR term_char : INTEGER; term_mask : INTEGER; value_array : ARRAY OF STRING; attach_wind : BOOLEAN; VAR status : INTEGER)', 'Displays and controls a table on the teach pendant.');
b('DISCTRL_SBMN', 'DISCTRL_SBMN(dict_name : STRING; element_no : INTEGER; def_item : INTEGER; VAR term_char : INTEGER; VAR status : INTEGER)', 'Creates and controls cursor movement and selection in a sub-window menu.');
b('INIT_TBL', 'INIT_TBL(dict_name : STRING; ele_number : INTEGER; num_rows : INTEGER; num_columns : INTEGER; col_data : ARRAY OF COL_DESC_T; inact_array : ARRAY OF BOOLEAN; change_array : ARRAY OF ARRAY OF BOOLEAN; value_array : ARRAY OF STRING; VAR vptr_array : ARRAY OF ARRAY OF INTEGER; table_data : XWORK_T; VAR status : INTEGER)', 'Initializes a table on the teach pendant.');
b('ACT_TBL', 'ACT_TBL(action : INTEGER; VAR def_item : INTEGER; VAR table_data : ...; VAR term_char : INTEGER; VAR attr_wind : INTEGER; VAR status : INTEGER)', 'Activates a table.');
b('READ_KB', 'READ_KB(file_var : FILE; VAR buffer : STRING; buffer_size : INTEGER; accept_mask : INTEGER; time_out : INTEGER; term_mask : INTEGER; init_data : STRING; VAR n_chars_got : INTEGER; VAR term__char : INTEGER; VAR status : INTEGER)', 'Read from a keyboard device and wait for completion.');
b('INI_DYN_DISB', 'INI_DYN_DISB(VAR b_var : BOOLEAN; window_name : STRING; field_width : INTEGER; attributes : INTEGER; char_size : INTEGER; row : INTEGER; col : INTEGER; interval : INTEGER; buffer_size : INTEGER; VAR status : INTEGER)', 'Dynamic display of a BOOLEAN.');
b('INI_DYN_DISI', 'INI_DYN_DISI(i_var : INTEGER; window_name : STRING; field_width : INTEGER; attr_mask : INTEGER; char_size : INTEGER; row : INTEGER; col : INTEGER; interval : INTEGER; buffer_size : INTEGER; format : STRING; VAR status : INTEGER)', 'Initiate the dynamic display of an INTEGER variable in a specified window.');
b('INI_DYN_DISR', 'INI_DYN_DISR(r_var : REAL; window_name : STRING; field_width : INTEGER; attr__mask : INTEGER; char_size : INTEGER; row : INTEGER; col : INTEGER; interval : INTEGER; buffer_size : INTEGER; format : STRING; VAR status : INTEGER)', 'Initiates the dynamic display of a REAL variable in a specified window.');
b('INI_DYN_DISS', 'INI_DYN_DISS(s_var : STRING; window_name : STRING; field_width : INTEGER; attr__mask : INTEGER; char_size : INTEGER; row : INTEGER; col : INTEGER; interval : INTEGER; buffer_size : INTEGER; format : STRING; VAR status : INTEGER)', 'Initiates the dynamic display of a STRING variable in a specified window.');
b('CNC_DYN_DISB', 'CNC_DYN_DISB(VAR b_var : BOOLEAN; window_name : STRING; VAR status : INTEGER)', 'Cancels dynamic display of a BOOLEAN.');
b('CNC_DYN_DISI', 'CNC_DYN_DISI(VAR i_var : INTEGER; window_name : STRING; VAR status : INTEGER)', 'Cancels dynamic display of an INTEGER.');
b('CNC_DYN_DISR', 'CNC_DYN_DISR(VAR r_var : REAL; window_name : STRING; VAR status : INTEGER)', 'Cancels dynamic display of a REAL.');
b('CNC_DYN_DISS', 'CNC_DYN_DISS(VAR s_var : STRING; window_name : STRING; VAR status : INTEGER)', 'Cancels dynamic display of a STRING.');

// Errors / time / misc
b('POST_ERR', 'POST_ERR(error_code : INTEGER; parameter : STRING; cause_code : INTEGER; severity : INTEGER)', 'Posts an alarm. Use error_code from your own alarm range or a user alarm code; severity 0 = WARN, 1 = PAUSE, 2 = ABORT.');
b('POST_ERR_L', 'POST_ERR_L(error_code : INTEGER; parameter : STRING; cause_code : INTEGER; severity : INTEGER)', 'Posts the error code with local severity to the error reporting system to display and keep history of the errors.');
b('ERR_DATA', 'ERR_DATA(seq_num : INTEGER; VAR error_code : INTEGER; VAR error_string : STRING; VAR cause_code : INTEGER; VAR cause_string : STRING; VAR time_int : INTEGER; VAR severity : INTEGER; VAR prog_nam : STRING)', 'Reads an entry of the alarm log.');
b('GET_TIME', 'GET_TIME(VAR time_int : INTEGER)', 'Current controller time as packed INTEGER.');
b('SET_TIME', 'SET_TIME(time_int : INTEGER)', 'Sets the controller clock.');
b('GET_USEC_TIM', 'GET_USEC_TIM', 'Microsecond timer value.', 'INTEGER');
b('GET_USEC_SUB', 'GET_USEC_SUB(start_time : INTEGER; end_time : INTEGER)', 'Difference of two microsecond timer values.', 'INTEGER');
b('KCL', 'KCL(command : STRING; VAR status : INTEGER)', 'Executes a KCL command and waits.');
b('KCL_NO_WAIT', 'KCL_NO_WAIT(command : STRING; VAR status : INTEGER)', 'Executes a KCL command without waiting.');
b('KCL_STATUS', 'KCL_STATUS()', 'Returns the status of the last executed command from either KCL or KCL_NO_WAIT built-in procedures.', 'INTEGER');
b('PIPE_CONFIG', 'PIPE_CONFIG(pipe_name : STRING; cmos_flag : BOOLEAN; n_sectors : INTEGER; record_size : INTEGER; form_dict : STRING; form_ele : INTEGER; VAR status : INTEGER)', 'Configures a pipe device.');
b('MSG_CONNECT', "MSG_CONNECT(tag : STRING; VAR status : INTEGER)", 'Connects a socket messaging tag (S1:..S8:, C1:..C8:).');
b('MSG_DISCO', 'MSG_DISCO(tag : STRING; VAR status : INTEGER)', 'Disconnects a socket messaging tag.');
b('MSG_PING', 'MSG_PING(host_name : STRING; VAR status : INTEGER)', 'Pings a host.');
b('SEND_DATAPC', 'SEND_DATAPC(event_no : INTEGER; dat_buffer : ARRAY OF BYTE; VAR status : INTEGER)', 'To send an event message and other data to the PC.');
b('SEND_EVENTPC', 'SEND_EVENTPC(event_no : INTEGER; VAR status : INTEGER)', 'Sends an event to PC.');
b('ADD_INTPC', 'ADD_INTPC(dat_buffer : ARRAY OF BYTE; dat_index : INTEGER; number : INTEGER; VAR status : INTEGER)', 'To add an INTEGER value (type 16 - 10 HEX) into a KAREL byte data buffer.');
b('ADD_REALPC', 'ADD_REALPC(dat_buffer : ARRAY OF BYTE; dat_index : INTEGER; number : REAL; VAR status : INTEGER)', 'To add a REAL value (type 17 - 11 HEX) into a KAREL byte data buffer.');
b('ADD_STRINGPC', 'ADD_STRINGPC(dat_buffer : ARRAY OF BYTE; dat_index : INTEGER; item : STRING; VAR status : INTEGER)', 'To add a string value (type 209 - D1 HEX) into a KAREL byte data buffer.');
b('ADD_BYNAMEPC', 'ADD_BYNAMEPC(dat_buffer : ARRAY OF BYTE; dat_index : INTEGER; prog_name : STRING; var_name : STRING; VAR status : INTEGER)', 'To add an integer, real, or string value into a KAREL byte given a data buffer.');
b('APPEND_NODE', 'APPEND_NODE(path_var : PATH; VAR status : INTEGER)', 'Appends a node to a path.');
b('INSERT_NODE', 'INSERT_NODE(path_var : PATH; node_num : INTEGER; VAR status : INTEGER)', 'Inserts a node before node_num.');
b('DELETE_NODE', 'DELETE_NODE(path_var : PATH; node_num : INTEGER; VAR status : INTEGER)', 'Deletes a path node.');
b('NODE_SIZE', 'NODE_SIZE(path_var : PATH)', 'Size of a path node in bytes.', 'INTEGER');
b('PATH_LEN', 'PATH_LEN(path_var : PATH)', 'Number of nodes in a path.', 'INTEGER');
b('COPY_PATH', 'COPY_PATH(src : PATH; start_node : INTEGER; end_node : INTEGER; VAR dest : PATH; VAR status : INTEGER)', 'Copies path nodes.');
b('VREG_FND_POS', 'VREG_FND_POS(vreg_no : INTEGER; VAR found_pos : XYZWPREXT; VAR model_id : INTEGER; VAR status : INTEGER)', 'Reads the found position from vision register VR[n].');
b('VREG_OFFSET', 'VREG_OFFSET(vreg_no : INTEGER; VAR offset : XYZWPREXT; VAR status : INTEGER)', 'Reads the offset from vision register VR[n].');
b('XML_SCAN', 'XML_SCAN(xml_file : FILE; VAR tag_name : STRING; VAR tag_ident : INTEGER; VAR func_code : INTEGER; VAR status : INTEGER)', 'Scan through a previously opened XML file.');
b('XML_GETDATA', 'XML_GETDATA(xml_file : FILE; VAR numattr : INTEGER; VAR attrnames : ARRAY OF STRING; VAR attrvalues : ARRAY OF STRING; VAR textdata : STRING; VAR textdone : BOOLEAN; VAR status : INTEGER)', 'Returns the attribute names and values associated with the tag causing the return.');
b('XML_ADDTAG', 'XML_ADDTAG(file_id : FILE; tag : STRING; attr_name : ARRAY OF STRING; attr_val : ARRAY OF STRING; num_p : INTEGER; VAR status : INTEGER)', 'Adds a tag.');
b('XML_REMTAG', 'XML_REMTAG(file_id : FILE; tag : STRING; VAR status : INTEGER)', 'Removes a tag.');
b('XML_SETVAR', 'XML_SETVAR(file_id : FILE; prog_name : STRING; var_name : STRING; VAR status : INTEGER)', 'Binds a variable for XML parsing.');
b('TRANSLATE', 'TRANSLATE(file_spec : STRING; listing_sw : BOOLEAN; VAR status : INTEGER)', 'Translates a KAREL source file (.KL file type) into p-code (.PC file type), which can be loaded into memory and executed.');
b('MIRROR', 'MIRROR(old_pos : POSITION; mirror_frame : POSITION; orient_flag : BOOLEAN)', 'Determines the mirror image of a specified position variable.', 'XYZWPREXT');
b('ORIENT', 'ORIENT(posn : POSITION)', 'Returns a unit VECTOR representing the y-axis (orient vector) of the specified POSITION argument.', 'VECTOR');
b('APPROACH', 'APPROACH(posn : POSITION)', 'Returns a unit VECTOR representing the z-axis of a POSITION argument.', 'VECTOR');
b('WAIT_FOR', 'WAIT FOR <condition>', 'Statement: waits until the condition is true.');
b('DELAY', 'DELAY <milliseconds>', 'Statement: pauses the task for the given milliseconds.');
b('PULSE', 'PULSE DOUT[n] FOR <ms> [NOWAIT]', 'Statement: pulses a digital output.');
b('ABORT', 'ABORT [PROGRAM[n]]', 'Statement: aborts the current (or named) task.');
b('PAUSE', 'PAUSE [PROGRAM[n]]', 'Statement: pauses the task.');
b('CONDITION', 'CONDITION[n]: WHEN <cond> DO <action> ENDCONDITION', 'Statement: defines a condition handler; enable with ENABLE CONDITION[n].');

// ---- From the KAREL Reference Manual V9.40 (added 2026-10-01): built-ins this table did not have ----

// Other
b('BYNAME', 'BYNAME(prog_name : STRING; var_name : STRING; entry : INTEGER)', 'Allows a KAREL program to pass a variable, whose name is contained in a STRING, as a parameter to a KAREL routine. This means the programmer does not have to determine the variable name during program creation and translation.', '(the named variable, passed by reference)');
b('CNC_DYN_DISE', 'CNC_DYN_DISE(e_var : INTEGER; window_name : STRING; VAR status : INTEGER)', 'Cancels the dynamic display based on the value of an INTEGER variable in a specified window.');
b('CNC_DYN_DISP', 'CNC_DYN_DISP(port_type : INTEGER; port_no : INTEGER; window_name : STRING; VAR status : INTEGER)', 'Cancels the dynamic display based on the value of a port in a specified window.');
b('CNV_CNF_STRG', 'CNV_CNF_STRG(source : CONFIG; VAR target : STRING; group_no : INTEGER)', 'Converts the specified CONFIG into a STRING using an optional group_no.');
b('DEL_INST_TPE', 'DEL_INST_TPE(open_id : INTEGER; lin_num : INTEGER; VAR status : INTEGER)', 'Deletes the specified instruction in the specified teach pendant program.');
b('DISCTRL_PLMN', 'DISCTRL_PLMN(dict_name : STRING; element_no : INTEGER; ftn_key_num : INTEGER; def_item : INTEGER; VAR term_char : INTEGER; VAR status : INTEGER)', 'Creates and controls cursor movement and selection in a pull-up menu.');
b('FORCE_LINK', 'FORCE_LINK(pane_id : INTEGER; url : STRING)', 'Forces the display of custom web pages or generic links.');
b('GET_POS_FRM', 'GET_POS_FRM(open_id : INTEGER; position_no : INTEGER; gnum : INTEGER; VAR ufram_no : INTEGER; VAR utool_no : INTEGER; VAR status : INTEGER)', 'Gets the uframe number and utool number of the specified position in the specified teach pendant program.');
b('INI_DYN_DISE', 'INI_DYN_DISE(e_var : INTEGER; window_name : STRING; field_width : INTEGER; attr_mask : INTEGER; char_size : INTEGER; row : INTEGER; col : INTEGER; interval : INTEGER; strings : ARRAY OF STRING; VAR status : INTEGER)', 'Initiates the dynamic display of an INTEGER variable. This procedure displays elements of a STRING ARRAY depending of the current value of the INTEGER variable.');
b('INI_DYN_DISP', 'INI_DYN_DISP(port_type : INTEGER; port_no : INTEGER; window_name : STRING; field_width : INTEGER; attr_mask : INTEGER; char_size : INTEGER; row : INTEGER; col : INTEGER; interval : INTEGER; strings : ARRAY OF STRING; VAR status : INTEGER)', 'Initiates the dynamic display of a value of a port in a specified window, based on the port type and port number.');
b('MSG_CONNECT', 'MSG_CONNECT(tag : STRING; VAR status : INTEGER)', 'Connect a client or server port to another computer for use in Socket Messaging.');
b('POP_KEY_RD', 'POP_KEY_RD(key_dev_name : STRING; pop_index : INTEGER; VAR status : INTEGER)', 'Resumes key input from a keyboard device.');
b('PUSH_KEY_RD', 'PUSH_KEY_RD(key_dev_name : STRING; key_mask : INTEGER; VAR pop_index : INTEGER; VAR status : INTEGER)', 'Suspend key input from a keyboard device.');
b('QUEUE_ATTACH', 'QUEUE_ATTACH(msg_type : STRING; attachments : ARRAY OF STRING; priority : INTEGER; VAR status : INTEGER)', 'Attaches the files to given message type and sets message priority (available in v830P/15 and later).');
b('RENAME_VARS', 'RENAME_VARS(old_nam : STRING; new_nam : STRING; VAR status : INTEGER)', 'Renames all of the variables in a specified program to a new program name.');
b('RESET', 'RESET(VAR successful : BOOLEAN)', 'Resets the controller.');
b('RMCN_ALERT', 'RMCN_ALERT(alertaddr : STRING; subject : STRING; message : STRING; alerturl : STRING; VAR status : INTEGER)', 'Sends an alert to the phone so that the user is immediately notified without requiring the iRConnect mobile application to be active. (available in v8.20 and later).');
b('RMCN_SEND', 'RMCN_SEND(xml_file : STRING; attachments : ARRAY OF STRING; priority : INTEGER; VAR status : INTEGER)', 'Sends user defined message as an email via iRConnect (available in v8.10 and v830P/14 or earlier).');
b('SET_LANG', 'SET_LANG(lang_name : STRING; VAR status : INTEGER)', 'Changes the current language.');

// Data Acquisition (DAQ)
b('DAQ_CHECKP', 'DAQ_CHECKP(pipe_num : INTEGER; VAR pipe_stat : INTEGER; VAR bytes_avail : INTEGER)', 'To check the status of a pipe and the number of bytes available to be read from the pipe.');
b('DAQ_REGPIPE', 'DAQ_REGPIPE(pipe_num : INTEGER; mem_type : INTEGER; pipe_size : INTEGER; prog_name : STRING; var_name : STRING; pipe_name : STRING; stream_size : INTEGER; VAR status : INTEGER)', 'To register a pipe for use in KAREL.');
b('DAQ_START', 'DAQ_START(pipe_num : INTEGER; pipe_mode : INTEGER; stream_dev : STRING; VAR status : INTEGER)', 'To activate a KAREL pipe for writing.');
b('DAQ_STOP', 'DAQ_STOP(pipe_num : INTEGER; force_off : BOOLEAN; VAR status : INTEGER)', 'To stop a KAREL pipe for writing.');
b('DAQ_UNREG', 'DAQ_UNREG(pipe_num : INTEGER; VAR status : INTEGER)', 'To unregister a previously-registered KAREL pipe, so that it may be used for other data.');
b('DAQ_WRITE', 'DAQ_WRITE(pipe_num : INTEGER; prog_name : STRING; var_name : STRING; VAR status : INTEGER)', 'To write data to a KAREL pipe.');

// Data Transfer Between Robots (RPCC)
b('RGET_PORTCMT', 'RGET_PORTCMT(host_port : STRING; port_type : INTEGER; port_no : INTEGER; VAR comment_str : INTEGER; VAR status : INTEGER)', 'To allow a KAREL program to determine a comment that is set for a specified logical port of a remote host. Needs Data Transfer Between Robots (J740).');
b('RGET_PORTSIM', 'RGET_PORTSIM(host_port : STRING; port_type : INTEGER; port_no : INTEGER; VAR simulated : BOOLEAN; VAR status : INTEGER)', 'To get port simulation status from the remote controller. Needs Data Transfer Between Robots (J740).');
b('RGET_PORTVAL', 'RGET_PORTVAL(host_port : STRING; port_type : INTEGER; port_no : INTEGER; VAR port_value : INTEGER; VAR status : INTEGER)', 'To allow a KAREL program to determine the current value of a specified logical port of a remote host. Needs Data Transfer Between Robots (J740).');
b('RGET_PREGCMT', 'RGET_PREGCMT(host_port : STRING; register_no : INTEGER; VAR comment_str : STRING; VAR status : INTEGER)', 'To retrieve a comment of a position register of remote host. Needs Data Transfer Between Robots (J740).');
b('RGET_REG', 'RGET_REG(host_port : STRING; register_no : INTEGER; VAR real_flag : BOOLEAN; VAR int_value : INTEGER; VAR real_value : REAL; VAR status : INTEGER)', 'To get an INTEGER or REAL value from the specified register of remote host. Needs Data Transfer Between Robots (J740).');
b('RGET_REG_CMT', 'RGET_REG_CMT(host_port : STRING; register_no : INTEGER; VAR comment_str : STRING; VAR status : INTEGER)', 'To get comment from the specified register of a remote host. Needs Data Transfer Between Robots (J740).');
b('RGET_SREGCMT', 'RGET_SREGCMT(host_port : STRING; register_no : INTEGER; VAR comment_str : STRING; VAR status : INTEGER)', 'To get comment from the specified string register of a remote host. Needs Data Transfer Between Robots (J740).');
b('RGET_STR_REG', 'RGET_STR_REG(host_port : STRING; register_no : INTEGER; VAR value : STRING[254]; VAR status : INTEGER)', 'To get a value from the specified string register of a remote host. Needs Data Transfer Between Robots (J740).');
b('RNUMREG_RECV', 'RNUMREG_RECV(host_port : STRING; src_idx : INTEGER; dest_idx : INTEGER; option : INTEGER; status : INTEGER)', 'To transfer a server’s register to a client’s register. Needs Data Transfer Between Robots (J740).');
b('RNUMREG_SEND', 'RNUMREG_SEND(host_port : STRING; dest_idx : INTEGER; src_idx : INTEGER; option : INTEGER; status : INTEGER)', 'To transfer a client’s register to a server’s register. Needs Data Transfer Between Robots (J740).');
b('RPREG_RECV', 'RPREG_RECV(host_port : STRING; src_idx : INTEGER; src_grp : INTEGER; dest_idx : INTEGER; dest_grp : INTEGER; option : INTEGER; status : INTEGER)', 'To transfer position register of specified group of server to position register of specified group of client. Needs Data Transfer Between Robots (J740).');
b('RPREG_SEND', 'RPREG_SEND(host_port : STRING; dest_idx : INTEGER; dest_grp : INTEGER; src_idx : INTEGER; src_grp : INTEGER; option : INTEGER; status : INTEGER)', 'To transfer position register of specified group of client to position register of specified group of server. Needs Data Transfer Between Robots (J740).');
b('RSET_INT_REG', 'RSET_INT_REG(host_port : STRING; register_no : BOOLEAN; int_value : INTEGER; VAR status : INTEGER)', 'To store an in INTEGER value in the specified register of remote host. Needs Data Transfer Between Robots (J740).');
b('RSET_PORTCMT', 'RSET_PORTCMT(host_port : STRING; port_type : INTEGER; port_no : INTEGER; comment_str : INTEGER; VAR status : INTEGER)', 'To allow a KAREL program to set comment of specified logical port of remote host. Needs Data Transfer Between Robots (J740).');
b('RSET_PORTSIM', 'RSET_PORTSIM(host_port : STRING; port_type : INTEGER; port_no : INTEGER; value : INTEGER; VAR status : INTEGER)', 'To set port simulated on remote host. Needs Data Transfer Between Robots (J740).');
b('RSET_PORTVAL', 'RSET_PORTVAL(host_port : STRING; port_type : INTEGER; port_no : INTEGER; port_value : INTEGER; VAR status : INTEGER)', 'To allow KAREL program to set a specified output (or simulated input) for a specified logical port. Needs Data Transfer Between Robots (J740).');
b('RSET_PREGCMT', 'RSET_PREGCMT(host_port : STRING; register_no : INTEGER; comment_str : STRING; VAR status : INTEGER)', 'To set comment of a position register of remote host. Needs Data Transfer Between Robots (J740).');
b('RSET_REALREG', 'RSET_REALREG(host_port : STRING; register_no : BOOLEAN; real_value : REAL; VAR status : INTEGER)', 'To store a REAL value in the specified register of remote host. Needs Data Transfer Between Robots (J740).');
b('RSET_REG_CMT', 'RSET_REG_CMT(host_port : STRING; register_no : INTEGER; comment_str : STRING; VAR status : INTEGER)', 'To set comment of numeric register of remote host. Needs Data Transfer Between Robots (J740).');
b('RSET_SREGCMT', 'RSET_SREGCMT(host_port : STRING; register_no : INTEGER; comment_str : STRING; VAR status : INTEGER)', 'Sets the comment for the specified string register of the remote robot controller. Needs Data Transfer Between Robots (J740).');
b('RSET_STR_REG', 'RSET_STR_REG(host_port : STRING; register_no : INTEGER; VAR value : STRING[254]; VAR status : INTEGER)', 'To set the specified value for the specified string register of the remote host. Needs Data Transfer Between Robots (J740).');

// iRVision (CVIS)
b('VT_ACK_QUEUE', 'VT_ACK_QUEUE(area_num : INTEGER; vreg_num : INTEGER; ack : INTEGER; VAR status : INTEGER)', 'This is a built-in for visual tracking. It acknowledges how a workpiece allocated by VT_GET_QUEUE call was handled to a specified work area. Needs iRVision.');
b('VT_CLR_QUEUE', 'VT_CLR_QUEUE(area_num : INTEGER; VAR status : INTEGER)', 'This is a built-in for visual tracking. It clears information of workpieces present in a specified work area. When called, all the information of the workpieces in the work area is entirely erased. Usually, this built-in is called just once when the system is started. Needs iRVision.');
b('VT_DELETE_PQ', 'VT_DELETE_PQ(area_num : INTEGER; work_id : INTEGER; VAR status : INTEGER)', 'This is a built-in for visual tracking customization. This function deletes a part from a queue. The part is identified by a work ID. CAUTION This built-in cannot be used together with Load Balance function. This built-in cannot delete a cell of a tray by default. If you want to delete a cell of a tray, you set a flag to the system variable $VTLINE[n].$FLAG in all robots before you start the robot controller program. You will be able to delete a cell of a tray in V7.70P/30 and later. 1. Find the system variable $VTLINE[n] whose $NAME is identical to the name of the line where the work area belongs. 2. Divide $VTLINE[n].$FLAG by 128 and get the quotient of the division. 3. If the quotient is an even number, add 128 to $VTLINE[n].$FLAG to enable the function. If the quotient is an odd number, do nothing because the function has already been enabled. 4. This setting is required for all robots. Needs iRVision.');
b('VT_GET_AREID', 'VT_GET_AREID(area_name : STRING)', 'This is a built-in for visual tracking. It returns the work area number got from a specified work area name. Needs iRVision.', 'INTEGER');
b('VT_GET_FOUND', 'VT_GET_FOUND(vp_name : STRING; VAR model_id : INTEGER; VAR enc_count : INTEGER; VAR offset : XYZWPR; VAR found_pos : ARRAY[4] OF XYZWPR; VAR meas_val : ARRAY[10] OF REAL; VAR status : INTEGER)', 'This is a built-in for visual tracking. It outputs the information of a workpiece that a vision program finds. Needs iRVision.');
b('VT_GET_LINID', 'VT_GET_LINID(line_name : STRING)', 'This is a built-in for visual tracking. It returns the line number got from a specified line name. Needs iRVision.', 'INTEGER');
b('VT_GET_PFRT', 'VT_GET_PFRT(area_num : INTEGER; consecutive : INTEGER; num_consct : INTEGER; model_id : INTEGER; VAR pfrt : INTEGER; VAR status : INTEGER)', 'This is a built-in for visual tracking. It returns the rate at which the workpieces flow through the work area in one minute (expected workpiece flow rate). Needs iRVision.');
b('VT_GET_QUEUE', 'VT_GET_QUEUE(area_num : INTEGER; vreg_num : INTEGER; timeout : INTEGER; consecutive : INTEGER; model_id : INTEGER; work_id : INTEGER; VAR status : INTEGER)', 'This is a built-in for visual tracking. It gets the information of one workpiece from a specified work area. The information of the gotten workpiece is stored in a vision register. The value of the encoder for the gotten workpiece is set as the trigger of a tracking motion. When there is no workpiece to be handled in the work area, the robot waits by a specified time until a workpiece actually reaches the work area. Needs iRVision.');
b('VT_GET_TIME', 'VT_GET_TIME(area_num : INTEGER; consecutive : INTEGER; model_id : INTEGER; work_id : INTEGER; VAR time : INTEGER; VAR status : INTEGER)', 'This is a built-in for visual tracking. It returns the estimated time to take until the next workpiece that can be handled arrives at a specified work area. Needs iRVision.');
b('VT_GET_TRYID', 'VT_GET_TRYID(tray_name : STRING)', 'This is a built-in for visual tracking. It returns the tray number got from a specified tray name. Needs iRVision.', 'INTEGER');
b('VT_PUT_QUE2', 'VT_PUT_QUE2(line_num : INTEGER; work_id : INTEGER; tray_num : INTEGER; enc_count : INTEGER; model_id : INTEGER; offset : XYZWPR; found_pos : ARRAY[4] OF XYZWPR; meas_val : ARRAY[10] OF REAL; VAR duplicated : BOOLEAN; VAR status : INTEGER)', 'This is a built-in for visual tracking. It pushes workpiece information into a tracking queue and outputs a duplication status that indicates whether the new part is pushed into the queue or not pushed because of double detection. The syntax of this built-in is almost the same as VT_PUT_QUEUE KAREL built-in except an argument to indicate the duplication status. Needs iRVision.');
b('VT_PUT_QUEUE', 'VT_PUT_QUEUE(line_num : INTEGER; work_id : INTEGER; tray_num : INTEGER; enc_count : INTEGER; model_id : INTEGER; offset : XYZWPR; found_pos : ARRAY[4] OF XYZWPR; meas_val : ARRAY[10] OF REAL; VAR status : INTEGER)', 'This is a built-in for visual tracking. It pushes workpiece information into a tracking queue. Needs iRVision.');
b('VT_READ_PQ', 'VT_READ_PQ(area_num : INTEGER; VAR vtpartq : PATH; VAR status : INTEGER)', 'This is a built-in for visual tracking customization. It reads the information of parts in a queue and copies them to a KAREL PATH variable. CAUTION This built-in cannot be used together with Load Balance function. This built-in cannot read the information of a cell of a tray by default. If you want to read the information of a cell of a tray, you set a flag to the system variable $VTLINE[n].$FLAG in all robots before you start the robot controller program. You will be able to read the information of a cell of a tray in V7.70P/30 and later. 1. Find the system variable $VTLINE[n] whose $NAME is identical to the name of the line where the work area belongs. 2. Divide $VTLINE[n].$FLAG by 128 and get the quotient of the division. 3. If the quotient is an even number, add 128 to $VTLINE[n].$FLAG to enable the function. If the quotient is an odd number, do nothing because the function has already been enabled. 4. This setting is required for all robots. Needs iRVision.');
b('VT_SET_FLAG', 'VT_SET_FLAG(line_num : INTEGER; line_bit2enb : INTEGER; line_bit2dab : INTEGER; area_bit2enb : ARRAY[32] OF INTEGER; area_bit2dab : ARRAY[32] OF INTEGER; VAR status : INTEGER)', 'This is a built-in for visual tracking. It enables or disables the multiple functions for a specified line or specified work areas at the same time. Needs iRVision.');
b('VT_SET_LDBAL', 'VT_SET_LDBAL(line_num : INTEGER; model_id : INTEGER; n2pick : ARRAY[32] OF INTEGER; n2pass : INTEGER; VAR status : INTEGER)', 'This is a built-in for visual tracking. It changes the load balance data of each work area on a specified line. Needs iRVision.');
b('VT_WRITE_PQ', 'VT_WRITE_PQ(area_num : INTEGER; work_id : INTEGER; model_id : INTEGER; enc_count : INTEGER; offset : XYZWPR; found_pos : XYZWPR; meas_value : ARRAY[10] OF REAL; VAR status : INTEGER)', 'This is a built-in for visual tracking customization. It writes the information of a part in a queue. The part is identified by a work ID. CAUTION This built-in cannot be used together with Load Balance function. This built-in cannot write the information of a cell of a tray by default. If you want to write the information of a cell of a tray, you set a flag to the system variable $VTLINE[n].$FLAG in all robots before you start the robot controller program. You will be able to write the information of a cell of a tray in V7.70P/30 and later. 1. Find the system variable $VTLINE[n] whose $NAME is identical to the name of the line where the work area belongs. 2. Divide $VTLINE[n].$FLAG by 128 and get the quotient of the division. 3. If the quotient is an even number, add 128 to $VTLINE[n].$FLAG to enable the function. If the quotient is an odd number, do nothing because the function has already been enabled. 4. This setting is required for all robots. Needs iRVision.');
b('V_ACQ_VAMAP', 'V_ACQ_VAMAP(sensor_name : STRING; partial : BOOLEAN; center_pos : VECTOR; VAR status : INTEGER)', 'Acquires a 3D area map using the specified 3D area sensor tool. Needs iRVision.');
b('V_ADJ_2D', 'V_ADJ_2D(register_no : INTEGER; x : REAL; y : REAL; VAR status : INTEGER)', 'Modifies the offset in a specified vision register by X and Y. Needs iRVision.');
b('V_CAM_CALIB', 'V_CAM_CALIB(cal_name : STRING; func_code : INTEGER; VAR status : INTEGER)', 'Finds the calibration grid for either a single plane or multiple plane calibration. Needs iRVision.');
b('V_CAM_CHECK', 'V_CAM_CHECK(camdata_name : STRING; VAR power_on : BOOLEAN; VAR status : INTEGER)', 'Gets the power status of the specified camera. Needs iRVision.');
b('V_CLR_VAMAP', 'V_CLR_VAMAP(sensor_name : STRING; VAR status : INTEGER)', 'Clears the 3D area map of a specified area sensor tool from memory. Needs iRVision.');
b('V_CSAPI_GETVALUE', 'V_CSAPI_GETVALUE(vp_name : STRING; vo_name : STRING; VAR value : REAL; VAR status : INTEGER)', 'An API for creating a custom screen for iRVision. Gets the value of the specified parameter. Needs iRVision.');
b('V_CSAPI_NUMSET', 'V_CSAPI_NUMSET(vp_name : STRING; num_values : REAL; VAR status : INTEGER)', 'An API for creating a custom screen for iRVision. Gets the number of values that have been overwritten by the V_CSAPI_SETVALUE built-in procedure. Needs iRVision.');
b('V_CSAPI_RESETDATA', 'V_CSAPI_RESETDATA(vp_name : STRING; VAR status : INTEGER)', 'An API for creating a custom screen for iRVision. Restores all the values overwritten by the V_CSAPI_SETVALUE built-in procedure for the specified vision process. Needs iRVision.');
b('V_CSAPI_SAVEDATA', 'V_CSAPI_SAVEDATA(vp_name : STRING; VAR status : INTEGER)', 'An API for creating a custom screen for iRVision. Saves the values overwritten by the V_CSAPI_SETVALUE built-in procedure in the specified vision process. Needs iRVision.');
b('V_CSAPI_SETVALUE', 'V_CSAPI_SETVALUE(vp_name : STRING; vo_name : STRING; value : REAL; VAR status : INTEGER)', 'An API for creating a custom screen for iRVision. Overwrites the value of the parameter specified by the vision override. Needs iRVision.');
b('V_CSAPI_TESTRUN', 'V_CSAPI_TESTRUN(vp_name : STRING; camera_view : INTEGER; VAR status : INTEGER)', 'An API for creating a custom screen for iRVision. Test-runs the specified vision process using the values overwritten by the V_CSAPI_SETVALUE built-in procedure. Needs iRVision.');
b('V_DISPLAY4D', 'V_DISPLAY4D(vistool_name : STRING; VAR status : INTEGER)', 'Displays the 4D Graphics screen for the specified vision tool on the iPendant. Needs iRVision.');
b('V_FIND_VIEW', 'V_FIND_VIEW(vp_name : STRING; camera_view : INTEGER; image_reg : INTEGER; VAR status : INTEGER)', 'Runs vision find processing on the specified vision process, using a previously captured image. When the vision process has more than one camera view, processing is performed for the specified view. Needs iRVision.');
b('V_FIND_VLINE', 'V_FIND_VLINE(vp_name : STRING; view_num : INTEGER; imreg_num : INTEGER; VAR vlines : PATH; VAR status : INTEGER)', 'Executes and Image To Points Vision Process. This is the dedicated built-in for the Image to Points Vision Process. This outputs the view lines that go through the points extracted from the found outline of a workpiece to a PATH variable. Needs iRVision.');
b('V_GET_FOUND', 'V_GET_FOUND(vp_name : STRING; VAR frm_num : INTEGER; VAR model_id : INTEGER; VAR enc_count : INTEGER; VAR offset : XYZWPR; VAR found_pos : ARRAY OF XYZWPR; VAR meas_val : ARRAY OF REAL; VAR status : INTEGER)', 'Gets the information of a found workpiece from a vision process and stores it in specified variables. Needs iRVision.');
b('V_GET_OFFSET', 'V_GET_OFFSET(vp_name : STRING; register_no : INTEGER; VAR status : INTEGER)', 'Gets a vision offset from a vision process and stores it in a specified vision register. Needs iRVision.');
b('V_GET_PASSFL', 'V_GET_PASSFL(vp_name : STRING; register_no : INTEGER; VAR status : INTEGER)', 'Gets the status of the error proofing vision process. It then stores the result in a specified numeric register. Needs iRVision.');
b('V_GET_READ', 'V_GET_READ(vp_name : STRING; sr_num : INTEGER; filename : STRING; VAR str_len : INTEGER; VAR status : INTEGER)', 'Get a result string of a reader vision process and stores it in a specified variables. Needs iRVision.');
b('V_GET_VPARAM', 'V_GET_VPARAM(vp_name : STRING; param_no : INTEGER; camera_view : INTEGER; reg_no : INTEGER; VAR status : INTEGER)', 'Retrieves the value of a vision parameter from a specified vision process. When the vision process has more than one camera view, the value is retrieved for the specified view. Needs iRVision.');
b('V_IRCONNECT', 'V_IRCONNECT(desc_string : STRING; priority : INTEGER; vis_reg_no : INTEGER; VAR status : INTEGER)', 'Sends the most recent iRVision result to mobile devices using iRConnect. Needs iRVision.');
b('V_LED_OFF', 'V_LED_OFF(VAR status : INTEGER)', 'Turns off an attached LED light for vision. The LED light must be attached to a multiplexer for analog cameras. Needs iRVision.');
b('V_LED_ON', 'V_LED_ON(channel : INTEGER; intensity : INTEGER; VAR status : INTEGER)', 'Turns on an LED light attached for vision. The LED light must be connected to a multiplexer for analog cameras. Needs iRVision.');
b('V_OVERRIDE', 'V_OVERRIDE(ovrd_name : STRING; value : REAL; VAR status : INTEGER)', 'Sets the value of the specified Vision Override tool. Needs iRVision.');
b('V_RUN_FIND', 'V_RUN_FIND(vp_name : STRING; camera_view : INTEGER; VAR status : INTEGER)', 'Starts an iRVision process. When a specified vision process has more than one camera view, location is performed for the specified camera views. Needs iRVision.');
b('V_SAVE_IMREG', 'V_SAVE_IMREG(image_reg : INTEGER; output_path : STRING; VAR status : INTEGER)', 'Saves an image from an image register to a file. Needs iRVision.');
b('V_SET_REF', 'V_SET_REF(vp_name : STRING; VAR status : INTEGER)', 'Sets the reference position in the specified vision process after V_RUN_FIND has been run. Needs iRVision.');
b('V_SNAP_VIEW', 'V_SNAP_VIEW(vp_name : STRING; camera_view : INTEGER; image_reg : INTEGER; VAR status : INTEGER)', 'Acquires an image using the specified vision process and stores it in an image register. When the vision process has more than one camera view, the image is acquired using the specified view. Needs iRVision.');

export const KAREL_BUILTINS: ReadonlyMap<string, KBuiltin> = new Map(B.map(x => [x.name.toUpperCase(), x]));
export const KAREL_BUILTIN_LIST: readonly KBuiltin[] = B;

/** System variables that come up constantly; hover docs. */
export const KAREL_SYSVARS: Record<string, string> = {
  '$MOTYPE': 'Motion type for MOVE: JOINT, LINEAR, CIRCULAR.',
  '$SPEED': 'Speed for MOVE statements (mm/sec for LINEAR).',
  '$TERMTYPE': 'Termination: FINE, COARSE, NOSETTLE, NODECEL, VARDECEL.',
  '$UFRAME': 'Active user frame (POSITION).',
  '$UTOOL': 'Active tool frame (POSITION).',
  '$GROUP': 'Per-group motion variables: $GROUP[n].$UFRAME, $GROUP[n].$UTOOL, $GROUP[n].$SPEED...',
  '$MNUFRAMENUM': 'Active user frame number per group: $MNUFRAMENUM[grp].',
  '$MNUTOOLNUM': 'Active tool frame number per group: $MNUTOOLNUM[grp].',
  '$MNUFRAME': 'User frame table: $MNUFRAME[grp,n].',
  '$MNUTOOL': 'Tool frame table: $MNUTOOL[grp,n].',
  '$NUMREG': 'Numeric registers ($NUMREG[n] via GET_VAR/SET_VAR with *NUMREG*).',
  '$WAITTMOUT': 'Timeout for WAIT ... TIMEOUT,LBL[n] in 10 ms units. Default 3000 = 30 s.',
  '$DEFPULSE': 'Default pulse width for DO[n]=PULSE in 0.1 s units.',
  '$MCR': 'Master control: $MCR.$GENOVERRIDE (speed override %).',
  '$SCR': 'System control record: $SCR.$NUM_GROUP etc.',
  '$MOR_GRP': 'Motion group status: $MOR_GRP[g].$CURRENT_ANG, $MOR_GRP[g].$SERVO_READY...',
  '$SHELL_WRK': 'Shell working variables: $SHELL_WRK.$CUST_NAME (selected program), $SHELL_WRK.$CUST_LINE...',
  '$TP_DEFPROG': 'Program currently selected on the pendant.',
  '$RMT_MASTER': 'Remote master: 0 UOP, 1 CRT/KB, 2 host, 3 none.',
  '$UALRM_MSG': 'User alarm messages: $UALRM_MSG[n].',
  '$UALRM_SEV': 'User alarm severities: $UALRM_SEV[n].',
  '$PARAM_GROUP': 'Group parameters: $PARAM_GROUP[g].$SPEEDLIM...',
  '$MNSING_CHK': 'Singularity check enable.',
  '$SEMIPOWERFL': 'Semi-hot start flag.',
  '$DMR_GRP': 'Mastering data: $DMR_GRP[g].$MASTER_DONE, $DMR_GRP[g].$MASTER_COUN.',
  '$STMO_VER': 'Software version string.',
  '$VERSION': 'Controller software version.',
  '$FAST_CLOCK': 'Free-running clock, 2 ms ticks (INTEGER).',
  '$TIMER': 'Program timers: $TIMER[n].$TIMER_VAL.',
  '$RPC_DATA': 'Remote procedure call data area.',
  '$AP_PLUGGED': 'Application plugged in (spot/arc/handling).',
  '$CELL_FLOOR': 'Cell floor frame (POSITION).',
  '$MNUFRAME_CNT': 'Number of user frames.',
  '$HTTP_CTRL': 'HTTP server control/authentication settings.',
  '$FILE_VAR': 'FILE variable table.',
  '$JOG_GROUP': 'Jog group state.',
};

/**
 * Names KAREL provides without a declaration: screen and device identifiers, port
 * arrays, and the well-known constants that appear as arguments to system builtins.
 *
 * Needed by the undeclared-variable check, which otherwise reports every one of them.
 * They are constants rather than functions, so they are not in KAREL_BUILTINS, and they
 * carry no `$`, so the parser does not skip them as system variables.
 */
export const KAREL_PREDEFINED = new Set<string>([
  // screens / menus used with FORCE_SPMENU, SET_CURSOR, WRITE ... and the SPI_ family
  'TP_PANEL', 'TP_USER', 'CRT_PANEL', 'CRT_USER', 'TP_KEYBOARD', 'CRT_KEYBOARD',
  'SPI_TPUSER', 'SPI_TPFUNC', 'SPI_TPPROMPT', 'SPI_TPSTATUS', 'SPI_TPERROR', 'SPI_TPDISPLAY',
  'SPI_CRTUSER', 'SPI_CRTFUNC', 'SPI_CRTPROMPT', 'SPI_CRTSTATUS', 'SPI_CRTERROR',
  // device / file strings
  'FROM_DEV', 'RAM_DEV', 'MC_DEV', 'MF_DEV', 'UD1_DEV', 'FR_DEV', 'RD_DEV',
  // motion and status constants
  'JOINT', 'LINEAR', 'CIRCULAR', 'FINE', 'COARSE', 'NOSETTLE', 'NODECEL', 'VARDECEL',
  'RSWORLD', 'AESWORLD', 'WRISTJOINT',
  // condition-handler and error constants that appear bare
  'NOABORT', 'NOMESSAGE', 'NOPAUSE', 'ABORT_TASK', 'PAUSE_TASK', 'CONTINUE_TASK',
  // task-status constants returned by GET_TSK_INFO / get_tsk_stat
  'PG_RUNNING', 'PG_PAUSED', 'PG_ABORTED', 'PG_RUN_KAREL', 'PG_RUN_TPE', 'PG_RESUMING',
  // KCL-from-KAREL helper, and the other SP* system routines that are not in the builtin table
  'SPRUNCMD', 'SPSETCMD', 'FORCE_SPMENU', 'SET_CURSOR',
  // and everything the KAREL environment files define (TSK_STATUS, ATR_IA, KY_PREV ...)
  ...KAREL_EV_NAMES,
]);
