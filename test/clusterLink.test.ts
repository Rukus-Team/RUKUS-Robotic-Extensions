/**
 * The cluster link/merge planner and the container schema additions. Synthetic and pure:
 * no RUKUS install, no VS Code host, so none of it can be skipped silently.
 * Wired in by test/run.ts: `run(check)`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { planClusterLink, aggregateBrand, describeRobotPlan } from '@core/clusterLink';
import {
  parseCellJson, parseRobotJson, writeCellMarker, writeRobotJson,
  CELL_DIR, CELL_JSON, ROBOT_DIR, ROBOT_JSON,
  type CellMarker, type RobotMarker,
} from '@core/robotContainers';
import type { RukusCluster, RukusRobot } from '@core/rukus/store';

const robot = (name: string, make = 'fanuc'): RukusRobot => ({
  name, host: '10.0.0.1', ftpUser: '', ftpDirectory: 'MD:/', device: 'MD:',
  isVirtual: false, isWriteLocked: false, make,
});

const cluster = (robots: RukusRobot[], name = 'C'): RukusCluster => ({ name, file: `${name}.json`, robots, raw: {} });

const marker = (root: string, name: string, controller?: string, brand?: 'fanuc' | 'abb'): RobotMarker => ({
  root, name, programDirs: undefined, excludeDirs: [],
  snapshotDir: path.join(root, ROBOT_DIR, 'snapshot'),
  markerPath: path.join(root, ROBOT_DIR, ROBOT_JSON),
  controller, brand,
});

export function run(check: (cond: unknown, msg: string) => void): void {
  // ---- brand aggregation ----
  check(aggregateBrand([robot('A'), robot('B')]) === 'fanuc', 'a FANUC cluster is a FANUC cell');
  check(aggregateBrand([robot('A', 'abb')]) === 'abb', 'an ABB cluster is an ABB cell');
  check(aggregateBrand([robot('A'), robot('B', 'abb')]) === 'mixed', 'a mixed cluster is a mixed cell');
  check(aggregateBrand([]) === undefined, 'a cluster with no robots has no brand');

  // ---- the plan: existing containers merge, new ones get a folder, the rest ask ----
  {
    const root = path.join('C:', 'cell');
    const cell: CellMarker = { root, name: 'Old name', controllers: { SLR1: { host: '1.1.1.1', device: 'MD:' } } };
    const markers = [marker(path.join(root, 'SLR1_10.0.0.1'), 'SLR1', 'SLR1', 'fanuc')];
    const plan = planClusterLink(cluster([robot('SLR1'), robot('SLR2')]), cell, markers, [path.join(root, 'SLR1_10.0.0.1'), path.join(root, 'SLR2_10.0.0.2')]);

    check(plan.renameCell && plan.cellName === 'C', 'the cell takes the cluster name, flagged as a rename');
    check(plan.changedControllers.includes('SLR1'), 'a changed controller host is listed for the confirmation');
    check(plan.controllers.SLR1.host === '10.0.0.1', 'the cluster host wins (inheritance)');
    check(plan.brand === 'fanuc', 'the cell brand is aggregated from the cluster');

    const slr1 = plan.robots.find(r => r.robot.name === 'SLR1')!;
    check(slr1.action === 'merge' && !!slr1.marker, 'an existing container is a merge, never a create');
    check(slr1.changes.length === 0, `an already-matching robot reports no changes: ${JSON.stringify(slr1.changes)}`);

    const slr2 = plan.robots.find(r => r.robot.name === 'SLR2')!;
    check(slr2.action === 'create' && slr2.folder?.endsWith('SLR2_10.0.0.2') === true, 'a robot with a matching folder is created there');
  }

  // ---- a mismatched container reports the fields it would change ----
  {
    const root = path.join('C:', 'cell');
    const markers = [marker(path.join(root, 'R1_x'), 'R1', 'WRONG', 'abb')];
    const plan = planClusterLink(cluster([robot('R1')]), { root, name: 'C', controllers: {} }, markers);
    const p = plan.robots[0];
    check(p.action === 'merge', 'the existing container is still a merge');
    check(p.changes.some(c => c.field === 'controller' && c.to === 'R1'), 'the controller binding change is reported');
    check(p.changes.some(c => c.field === 'brand' && c.to === 'fanuc'), 'the brand change is reported');
    check(describeRobotPlan(p).includes('controller'), `describeRobotPlan names the change: ${describeRobotPlan(p)}`);
  }

  // ---- no container and no folder: ask ----
  {
    const plan = planClusterLink(cluster([robot('NEW')]), { root: path.join('C:', 'cell'), name: 'C', controllers: {} }, []);
    check(plan.robots[0].action === 'choose-folder', 'a robot with no container and no folder asks where it goes');
  }

  // ---- schema: brand + rukus parse and survive a write ----
  {
    const cellText = JSON.stringify({ name: 'C', brand: 'mixed', rukus: { cluster: 'K', syncedUtc: '2026-01-01T00:00:00Z' }, controllers: { A: { host: '1.2.3.4' } } });
    const parsed = parseCellJson(cellText, path.join('C:', 'cell'));
    check(parsed.cell?.brand === 'mixed', 'cell.json brand parses');
    check(parsed.cell?.rukus?.cluster === 'K', 'cell.json rukus.cluster parses (it used to be write-only)');
    check(parsed.cell?.controllers.A.host === '1.2.3.4', 'controllers still parse');

    const bad = parseCellJson(JSON.stringify({ name: 'C', brand: 'kuka' }), path.join('C:', 'cell'));
    check(!bad.cell && bad.errors.some(e => /brand/.test(e)), 'an unknown cell brand is rejected');

    const r = parseRobotJson(JSON.stringify({ name: 'R', brand: 'abb' }), path.join('C:', 'r'));
    check(r.marker?.brand === 'abb', 'robot.json brand parses');
    const rbad = parseRobotJson(JSON.stringify({ name: 'R', brand: 'mixed' }), path.join('C:', 'r'));
    check(!rbad.marker && rbad.errors.some(e => /brand/.test(e)), 'a robot brand cannot be mixed');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-code-cell-'));
    try {
      writeCellMarker(tmp, { name: 'C', brand: 'fanuc', rukus: { cluster: 'K' }, controllers: { A: { host: 'h' } } });
      const written = parseCellJson(fs.readFileSync(path.join(tmp, CELL_DIR, CELL_JSON), 'utf8'), tmp).cell;
      check(written?.brand === 'fanuc' && written?.rukus?.cluster === 'K', 'writeCellMarker keeps brand and rukus');

      const robotRoot = path.join(tmp, 'R1');
      writeRobotJson(robotRoot, { name: 'R1', controller: 'A', brand: 'fanuc', programs: ['2_LS'] });
      const writtenRobot = parseRobotJson(fs.readFileSync(path.join(robotRoot, ROBOT_DIR, ROBOT_JSON), 'utf8'), robotRoot).marker;
      check(writtenRobot?.brand === 'fanuc' && writtenRobot?.controller === 'A', 'writeRobotJson keeps brand and controller');
      check(writtenRobot?.programDirs?.length === 1, 'robot.json programs are preserved');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}
