# 5. Containers and RUKUS

**Objective:** set up a multi-robot workspace, and connect it to RUKUS's clusters.

> Cell containers are **under development**: they work today, but the payoff grows as RUKUS
> cluster integration lands.

## Robot containers

A `.robocode-robot/` folder declares one robot's working area:

```json
{ "name": "S002R01", "programs": ["LS", "KL"], "controller": "S002R01" }
```

`programs` is the editable set; everything else (dated backups, archives) is invisible to the
extension. The snapshot lives in `.robocode-robot/snapshot/`.

## Cell containers

A `.robocode-cell/cell.json` at the workspace root is optional: a cell name and a map of
controllers. Robot containers work without it; a cell adds a name, one place for the controllers
robots bind to, and a home for cell-wide settings later. Passwords are never stored in
`cell.json` - they go into VS Code's secret storage.

## The RUKUS bridge

- Clicking a cluster in the **RUKUS Clusters** view opens its backup folder and writes the
  cluster's robots into `cell.json`.
- **Sync from RUKUS** re-reads the open cluster.
- **Send Cell to RUKUS…** writes the cell's controllers back as a cluster.

## Practice

1. Open the bundled tutorial cell (**Robot Code: Open the Tutorial Cell**) - it is a two-robot
   cell with a `cell.json`.
2. Turn on **Robot Code > Experimental: Robot Connections**.
3. **You should see** both robots' controllers in the **Controllers** view, read from `cell.json`
   with no robot added by hand.

## More

- How-to: `docs/how-to/cell-containers.md`
- Explanation: `docs/design-robocode-containers.md`
