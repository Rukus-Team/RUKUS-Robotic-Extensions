/**
 * Program templates: the /MN body a plant standard wants every new program to start
 * from - frames set, a main-loop label, the places to fill in. They live in settings
 * (`robotCode.tp.programTemplates`) next to the header templates and use the same
 * `${FIELD}` placeholders and the same "fill what is known, ask for the rest" rule.
 *
 * Pure: a template plus values in, body lines out; and the text of a whole new program
 * out, so the New TP Program wizard and the tests build the same file.
 */
import { expandHeader, AUTO_FIELDS, COMMENT_WIDTH, headerFields, type HeaderTemplate } from './headers';

export interface ProgramTemplate {
  name: string;
  description?: string;
  /** name of a header template (`robotCode.tp.headerTemplates`) this program style goes with; informational */
  header?: string;
  /** /MN body lines WITHOUT numbers or ` ;` - comments carry their own `!`, blank lines are '' */
  lines: string[];
}

export const DEFAULT_PROGRAM_TEMPLATES: ProgramTemplate[] = [
  { name: 'Empty', description: 'the header only - start from nothing', lines: [] },
  {
    name: 'Main loop',
    description: 'frames set, then a LBL[10] loop that runs until aborted',
    lines: [
      '!${RULE}',
      '!MAIN LOOP',
      '!${RULE}',
      'UFRAME_NUM=${UFRAME}',
      'UTOOL_NUM=${UTOOL}',
      '',
      'LBL[10:MAIN LOOP]',
      '!Put the cycle here',
      '',
      'JMP LBL[10]',
    ],
  },
];

/** the placeholders a template needs that are not filled automatically */
export function templatePrompts(t: ProgramTemplate): string[] {
  return headerFields(asHeader(t)).filter(f => !(AUTO_FIELDS as readonly string[]).includes(f));
}

/**
 * Fill a template's lines. Same rules as a header: an unanswered placeholder is left as
 * written and reported. `tooLong` lists comment lines whose text runs past what the
 * pendant shows; instruction lines have no such limit here.
 */
export function expandTemplate(t: ProgramTemplate, values: Record<string, string | undefined>): { lines: string[]; missing: string[]; tooLong: number[] } {
  const { lines, missing } = expandHeader(asHeader(t), values);
  const tooLong = lines.map((l, i) => (l.startsWith('!') && l.length - 1 > COMMENT_WIDTH ? i : -1)).filter(i => i >= 0);
  return { lines, missing, tooLong };
}

function asHeader(t: ProgramTemplate): HeaderTemplate { return { name: t.name, lines: t.lines }; }

/**
 * One body line laid out the way the controller writes it, without the number field:
 * motion lines hug the colon, everything else sits two spaces in, a blank line is `   ;`,
 * and every line ends in ` ;` unless it already does. This is what `renumber()` produces
 * from a typed line, so text built here needs no renumber edits afterwards.
 */
export function layoutBodyLine(line: string): string {
  const t = line.trim();
  if (t === '') return '   ;';
  const body = /^[JLCAS]\s/.test(t) ? t : '  ' + t;
  return /;\s*$/.test(body) ? body : body + ' ;';
}

/** body lines with their controller line numbers, starting at `first` */
export function numberedBodyLines(lines: string[], first = 1, width = 4): string[] {
  return lines.map((l, i) => `${String(first + i).padStart(width, ' ')}:${layoutBodyLine(l)}`);
}

/** body lines with the number field left blank, for inserting into a program the auto-renumber will number */
export function unnumberedBodyLines(lines: string[], width = 4): string[] {
  return lines.map(l => `${' '.repeat(width + 1)}${layoutBodyLine(l)}`);
}

export interface NewProgramSpec {
  name: string;
  comment: string;
  /** DEFAULT_GROUP value, e.g. `1,*,*,*,*` */
  group: string;
  /** header comment lines, already expanded, without the leading `!` */
  headerLines: string[];
  /** template body lines, already expanded, without numbers or terminators */
  bodyLines: string[];
  /** yy-mm-dd and hh:mm:ss as the /ATTR block writes them */
  date: string;
  time: string;
  /** the pendant's Sub Type: '' for an ordinary program, else the word written after the name on the /PROG line */
  subType?: ProgramSubType;
  /** Write protect ON: the pendant refuses edits until it is switched off */
  writeProtect?: boolean;
}

/**
 * The sub types worth offering. Counted in real backups: 947 plain, 681 Macro, 4 Cond (and a
 * handful of application-specific Job/Process, which the application's own screens create).
 */
export type ProgramSubType = '' | 'Macro' | 'Cond';
export const PROGRAM_SUB_TYPES: Array<{ subType: ProgramSubType; label: string; description: string }> = [
  { subType: '', label: 'TP program', description: 'an ordinary program (Sub Type: None)' },
  { subType: 'Macro', label: 'Macro', description: 'can be assigned in the macro table and run from a key, an input or an instruction' },
  { subType: 'Cond', label: 'Cond', description: 'condition handler for MONITOR / WHEN - logic only, no motion group' },
];

/** the /PROG line as the controller writes it: two spaces, the name, and for a sub type a tab, two spaces and the word */
export function progLine(name: string, subType: ProgramSubType = ''): string {
  return `/PROG  ${name.toUpperCase()}${subType ? `\t  ${subType}` : ''}`;
}

/**
 * The /ATTR COMMENT value: 16 characters, and never a double quote - the value is written
 * between quotes, so one inside it would end the value early and leave a file the
 * controller refuses to load. The wizard rejects it at the prompt; this is the backstop
 * for every other caller.
 */
export function attrComment(comment: string): string {
  return comment.replace(/"/g, "'").slice(0, 16);
}

/** the complete text of a new program: header comments first, then the template body, LINE_COUNT right */
export function buildProgramText(spec: NewProgramSpec): string {
  const upper = spec.name.toUpperCase();
  const header = spec.headerLines.length ? spec.headerLines : [spec.comment || upper];
  const body = numberedBodyLines([...header.map(l => `!${l}`), ...spec.bodyLines]);
  return [
    progLine(upper, spec.subType), '/ATTR', 'OWNER\t\t= MNEDITOR;', `COMMENT\t\t= "${attrComment(spec.comment)}";`, 'PROG_SIZE\t= 0;',
    `CREATE\t\t= DATE ${spec.date}  TIME ${spec.time};`, `MODIFIED\t= DATE ${spec.date}  TIME ${spec.time};`, 'FILE_NAME\t= ;', 'VERSION\t\t= 0;', `LINE_COUNT\t= ${body.length};`, 'MEMORY_SIZE\t= 0;', `PROTECT\t\t= ${spec.writeProtect ? 'READ' : 'READ_WRITE'};`,
    'TCD:  STACK_SIZE\t= 0,', '      TASK_PRIORITY\t= 50,', '      TIME_SLICE\t= 0,', '      BUSY_LAMP_OFF\t= 0,', '      ABORT_REQUEST\t= 0,', '      PAUSE_REQUEST\t= 0;',
    `DEFAULT_GROUP\t= ${spec.group};`, 'CONTROL_CODE\t= 00000000 00000000;', '/MN', ...body, '/POS', '/END', '',
  ].join('\n');
}
