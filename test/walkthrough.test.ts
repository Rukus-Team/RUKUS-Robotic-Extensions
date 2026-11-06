/**
 * The onboarding walkthroughs, the bundled tutorial cell, and the how-to links.
 *
 * None of it needs reference-backup, so none of it can be skipped silently. The walkthrough is
 * the first thing a new user sees and it has broken before - an `onLanguage:` completion event
 * VS Code does not support, and a step whose completion was gated by the very experimental
 * switch it was meant to introduce. Every step is held here to the rules the design follows
 * (docs/onboarding.md): one verb action, one completion event, an expected-result line, and a
 * theme-aware image. Wired in by test/run.ts: `run(check)`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseCellJson, parseRobotJson, normalizeTpForCompare, CELL_DIR, CELL_JSON, ROBOT_DIR, ROBOT_JSON } from '@core/robotContainers';

const repo = path.join(__dirname, '..');

/** commands VS Code itself provides, which a walkthrough may legitimately link to or complete on */
const BUILTIN = /^(workbench|markdown|vscode|editor)\./;

interface Step {
  id: string;
  title: string;
  description: string;
  when?: string;
  media?: { markdown?: string };
  completionEvents?: string[];
}
interface Walkthrough { id: string; title: string; description: string; featuredFor?: string[]; steps: Step[] }

export function run(check: (cond: unknown, msg: string) => void): void {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const walkthroughs: Walkthrough[] = manifest.contributes.walkthroughs ?? [];
  const commands = new Set<string>((manifest.contributes.commands ?? []).map((c: { command: string }) => c.command));
  const views = new Set<string>((manifest.contributes.views?.robotCode ?? []).map((v: { id: string }) => v.id));
  const settings = new Set<string>(Object.keys(manifest.contributes.configuration?.properties ?? {}));
  const known = (id: string) => commands.has(id) || BUILTIN.test(id);

  // ---- the three tracks exist, with unique ids ----
  check(walkthroughs.length === 3, `three onboarding walkthroughs (${walkthroughs.length})`);
  const ids = walkthroughs.map(w => w.id);
  check(new Set(ids).size === ids.length, `walkthrough ids unique: ${ids.join(', ')}`);
  for (const want of ['robotCode.gettingStarted', 'robotCode.robot', 'robotCode.rukus']) {
    check(ids.includes(want), `the "${want}" walkthrough is contributed`);
  }
  check(!ids.includes('robotCode.cellPreview'), 'the cell-containers walkthrough is not contributed (under development)');
  check(!!walkthroughs.find(w => w.id === 'robotCode.gettingStarted')?.featuredFor?.includes('*.ls'),
    'the offline walkthrough is featured for .ls files');

  const stepIds = new Set<string>();
  const allowedEvents = /^(onCommand|onView|onSettingChanged|onContext|onLink):/;
  const linkRe = /command:([A-Za-z0-9_.\-]+)/g;
  const svgRe = /!\[[^\]]*\]\(([^)]+\.svg)\)/g;
  for (const w of walkthroughs) {
    check(w.steps.length > 0, `${w.id} has steps`);
    for (const s of w.steps) {
      check(!stepIds.has(s.id), `step id unique: ${s.id}`);
      stepIds.add(s.id);
      check(!!s.title && !!s.description, `${s.id} has a title and description`);

      // the media file exists; every command: link resolves; it is the step's one action
      const md = s.media?.markdown;
      check(!!md, `${s.id} has markdown media`);
      if (md) {
        const file = path.join(repo, md);
        check(fs.existsSync(file), `${s.id} media exists: ${md}`);
        if (fs.existsSync(file)) {
          const text = fs.readFileSync(file, 'utf8');
          let links = 0;
          let m: RegExpExecArray | null;
          while ((m = linkRe.exec(text))) { links++; check(known(m[1]), `${s.id} links to a real command: ${m[1]}`); }
          check(links >= 1, `${s.id} has a verb action (a command: link) in its media`);
          check(/You should see/.test(text), `${s.id} media says what the user should see`);

          // any referenced image exists and is theme-aware
          const dir = path.dirname(file);
          let img: RegExpExecArray | null;
          while ((img = svgRe.exec(text))) {
            const svg = path.join(dir, img[1]);
            check(fs.existsSync(svg), `${s.id} image exists: ${img[1]}`);
            if (fs.existsSync(svg)) {
              check(/var\(--vscode-|currentColor/.test(fs.readFileSync(svg, 'utf8')), `${s.id} image is theme-aware: ${img[1]}`);
            }
          }
        }
      }

      // exactly the completion the step promises, using a supported prefix and a real target
      check((s.completionEvents ?? []).length >= 1, `${s.id} has a completion event`);
      for (const ev of s.completionEvents ?? []) {
        check(allowedEvents.test(ev), `${s.id} completion event has a supported prefix: ${ev}`);
        const match = /^([a-zA-Z]+):(.*)$/.exec(ev);
        const kind = match?.[1], target = match?.[2] ?? '';
        if (kind === 'onCommand') check(known(target), `${s.id} completes on a real command: ${target}`);
        if (kind === 'onView') check(views.has(target), `${s.id} completes on a real view: ${target}`);
        if (kind === 'onSettingChanged') check(settings.has(target), `${s.id} completes on a real setting: ${target}`);
      }
    }
  }

  // the broken event must not come back
  const allEvents = walkthroughs.flatMap(w => w.steps.flatMap(s => s.completionEvents ?? []));
  check(!allEvents.some(e => e.startsWith('onLanguage:')), 'no onLanguage completion event (VS Code does not support it)');

  // ---- the how-to layer ----
  const howtoIndex = path.join(repo, 'docs', 'how-to', 'README.md');
  check(fs.existsSync(howtoIndex), 'the how-to index exists');
  if (fs.existsSync(howtoIndex)) {
    const text = fs.readFileSync(howtoIndex, 'utf8');
    for (const m of text.matchAll(/\]\((?!https?:)([^)]+\.md)\)/g)) {
      check(fs.existsSync(path.join(path.dirname(howtoIndex), m[1])), `how-to link resolves: ${m[1]}`);
    }
  }
  const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  for (const m of readme.matchAll(/\]\((docs\/how-to\/[^)]+)\)/g)) {
    check(fs.existsSync(path.join(repo, m[1])), `README how-to link resolves: ${m[1]}`);
  }

  // ---- the tutorial cell ----
  const sample = path.join(repo, 'samples', 'tutorial-cell');
  check(fs.existsSync(sample), 'the tutorial cell is in the repo');
  const cell = parseCellJson(fs.readFileSync(path.join(sample, CELL_DIR, CELL_JSON), 'utf8'), sample);
  check(!!cell.cell && cell.errors.length === 0, `cell.json parses: ${cell.errors.join('; ')}`);
  check(Object.keys(cell.cell?.controllers ?? {}).length === 2, 'the cell defines two controllers');
  check(cell.cell?.controllers.S002R01?.host === '127.0.0.2' && cell.cell?.controllers.S002R05?.host === '127.0.0.3',
    'the sample controllers are 127.0.0.2 and 127.0.0.3');

  for (const robot of ['S002R01', 'S002R05']) {
    const root = path.join(sample, robot);
    const rf = path.join(root, ROBOT_DIR, ROBOT_JSON);
    check(fs.existsSync(rf), `${robot}/robot.json exists`);
    const parsed = parseRobotJson(fs.readFileSync(rf, 'utf8'), root);
    check(!!parsed.marker && parsed.errors.length === 0, `${robot}/robot.json parses: ${parsed.errors.join('; ')}`);
    check(parsed.marker?.controller === robot, `${robot} binds to its controller by name`);
    check(fs.existsSync(path.join(root, ROBOT_DIR, 'snapshot.json')), `${robot} has a snapshot.json`);
    check(fs.existsSync(path.join(root, ROBOT_DIR, 'snapshot')), `${robot} has a snapshot/ folder`);
  }

  // one program differs from its snapshot, one matches, one is the practice problem - through the
  // same normalizer the tree marker uses, so the sample really shows the states it promises
  const loadWorking = fs.readFileSync(path.join(sample, 'S002R01', 'LS', 'LOAD.LS'), 'utf8');
  const loadSnapshot = fs.readFileSync(path.join(sample, 'S002R01', ROBOT_DIR, 'snapshot', 'LOAD.LS'), 'utf8');
  check(loadWorking.includes('WAIT') && !loadSnapshot.includes('WAIT'), 'LOAD.LS differs from its snapshot by the WAIT line');
  check(normalizeTpForCompare(loadWorking) !== normalizeTpForCompare(loadSnapshot), 'the marker reads LOAD.LS as differing from its snapshot');
  const pickWorking = fs.readFileSync(path.join(sample, 'S002R05', 'LS', 'PICK.LS'), 'utf8');
  const pickSnapshot = fs.readFileSync(path.join(sample, 'S002R05', ROBOT_DIR, 'snapshot', 'PICK.LS'), 'utf8');
  check(pickWorking === pickSnapshot, 'PICK.LS matches its snapshot exactly');
  check(normalizeTpForCompare(pickWorking) === normalizeTpForCompare(pickSnapshot), 'the marker reads PICK.LS as synced');
  const bad = path.join(sample, 'S002R05', 'LS', 'BAD.LS');
  check(fs.existsSync(bad), 'the practice problem BAD.LS exists');
  check(fs.existsSync(bad) && /LBL\[99\]/.test(fs.readFileSync(bad, 'utf8')), 'BAD.LS carries the mistake the README describes');

  // the sample ships: .vscodeignore does not exclude samples/, but does exclude the deep tutorial
  const ignore = fs.readFileSync(path.join(repo, '.vscodeignore'), 'utf8').split(/\r?\n/).map(l => l.trim());
  check(!ignore.some(l => /^samples(\/|$)/.test(l)), '.vscodeignore does not exclude samples/');
  check(ignore.some(l => /^tutorial(\/|$)/.test(l)), '.vscodeignore excludes the deep-tutorial source (it is a separate download)');
}
