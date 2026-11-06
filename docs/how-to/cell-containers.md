# Set up a multi-robot cell container

> **Under development.** Cell containers work today, but they get more useful as RUKUS cluster
> integration lands - the reason to have one is to bridge a RUKUS cluster and a workspace.

A **cell container** is an optional `.robocode-cell/cell.json` at the workspace root. It holds a
cell name and a map of controllers. Robot containers work **without** it; a cell adds a name, one
place for the controllers robots bind to, and a home for cell-wide settings later.

## Make one by hand

1. Run **Initialize Cell Container…** (`robotCode.containers.initCell`).
2. Pick the cell root, name it, and optionally define the controllers - each with a host, a
   device path and a protocol (HTTP needs no login; FTP does).

Passwords are never stored in `cell.json` (or anywhere in the cell folder). They go into VS Code's
secret storage, so a `cell.json` is safe to commit or share.

## Bind a robot to a cell controller

In the robot's `robot.json`, name the controller:

```json
{ "name": "S002R01", "programs": ["LS", "KL"], "controller": "S002R01" }
```

The cell's controllers are registered as profiles when the workspace loads, so the **Controllers**
view is populated without adding each robot by hand.

## With RUKUS

- Clicking a cluster in the **RUKUS Clusters** view opens its backup folder and writes the
  cluster's robots into `cell.json`.
- **Sync from RUKUS** re-reads the open cluster and updates `cell.json`.
- **Send Cell to RUKUS…** writes the cell's controllers back to RUKUS as a cluster.

Full cluster-to-cell import is still under development; today the bridge covers names, addresses,
devices and FTP passwords.

## Try it

The bundled tutorial cell is a two-robot cell with a `cell.json` - see
**Robot Code: Open the Tutorial Cell**.
