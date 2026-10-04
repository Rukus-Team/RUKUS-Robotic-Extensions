# Robot kinematics: where to get them

Beta list 3, item 3 (2026-09-25). Research only; nothing here is built yet.

Today the extension refuses three things because it has no kinematic model:

- converting a taught point between joint angles and XYZWPR;
- applying an X/Y/Z offset to a joint-taught point;
- teaching a cartesian reading into a joint-stored point, or the reverse.

Both brands give us a way to do these.

## FANUC

### 1. From the backup (offline, recommended first)

`symotn.va` carries the full nominal model. On the reference backup, an R-2000iC/210L:

| Variable | Meaning |
|---|---|
| `$SCR_GRP[g].$ROBOT_ID`, `$ROBOT_MODEL` | model, e.g. `R-2000iC/210L` |
| `$SCR_GRP[g].$KINEM_ENB` | 2 = forward and inverse kinematics defined |
| `$MRR_GRP[g].$DH_A`, `$DH_D`, `$DH_ALPHA`, `$DH_THETA0` | DH link parameters, also under `$PARAM_GROUP[g]` |
| `$MOUNT_ANGLE`, `$MOSIGN`, `$UPPERLIMS`, `$LOWERLIMS`, `$AXISORDER` | mounting, axis direction, limits |

The reference robot has `$DH_A` = 312, 1075, 225 and `$DH_D` = -1730, -240. These match the ROS-Industrial URDF for that model exactly.

Things to settle before we trust it:

- **J2/J3 coupling: pinned 2026-09-25.** Every full backup carries `curpos.dg`, which holds the joint angles and the world XYZWPR for the same instant. So every backup is a test case, and no simulator is needed. On the reference backup, the backup's own DH values reproduce the recorded pose with this convention (`JN` in degrees → radians):
  - θ1 = J1, θ2 = −J2 + `$DH_THETA0[2]` (π/2), θ3 = J3 + J2, θ4 = J4, θ5 = J5, θ6 = J6.
  - The standard DH chain then gives the flange in world coordinates, with W/P/R read as R = Rz(r)·Ry(p)·Rx(w).
  - The result is within 0.07 mm on Y and Z and 0.01° on W/P/R. The remaining error is the 2-decimal rounding of the joints in `curpos.dg`.
  - X is off by exactly the rail's E1 (100 mm): on this robot the rail adds E1 along world X.
  - J4 was 0 in that reading, so its sign is not pinned yet. A second backup with J4 ≠ 0 settles it.
  - The check lives in a scratch script for now. It becomes a corpus test when the kinematics module is written.
- **Config.** Inverse kinematics has to choose the solution named by `CONFIG` (F/N, U/D, T/B and the turn numbers).
- **Older software.** It is not yet checked whether V8.30 backups expose `$DH_*` the same way. The virtual robot at 127.0.0.4 can answer that.
- **Calibration.** Robots running an "accurate" (calibrated) model differ slightly from the nominal DH values.

### 2. Ask the controller (exact)

The KAREL built-ins `JOINT2POS` (forward) and `POS2JOINT` (inverse, with a reference joint position that picks the solution) do the conversion. A small KAREL program, called through the web server as `/KAREL/<prog>?...`, would return the controller's own answer, including frames and config.

The live layer does not call `/KAREL/` yet. Two things are unverified: whether KAREL-over-HTTP is unlocked by default, and whether loading a .PC needs an option. The virtual robots are the place to try it.

### 3. Published models (fallback when there is no backup)

- ROS-Industrial support packages: https://github.com/ros-industrial/fanuc
- FANUC's ROS 2 model list: https://fanuc-corporation.github.io/fanuc_driver_doc/main/docs/fanuc_description/supported_models.html

## ABB

### 1. Robot Web Services (exact, recommended)

The RWS 1.0 manual for RobotWare 6 (3HAC050973-001) lists conversion actions on the mechanical unit:

- `POST /rw/motionsystem/mechunits/ROB_1?action=CalcPoseFromJoints`: forward.
- `POST ...?action=JointsFromCartesian`: inverse. It needs the old joints and a config.
- `POST ...?action=AllJointSolutions`

The reads `/rw/motionsystem/mechunits/ROB_1/jointtarget` and `/robtarget` exist on the real IRC5 crawl. The actions are not yet tested there, because the crawler skips `?action=` links. Do this in phase 4 with the RWS connector.

**What an ABB backup does not carry (checked 2026-09-25 on 24 IRC5 backups, RobotWare 6.13).** Unlike FANUC, `SYSPAR/MOC.cfg` has no nominal link geometry. The robot type is only a name (`-use_robot_type "ROB1_6700_LeanID_2.65_220"`), and the geometry lives inside RobotWare. What MOC.cfg does have:

- **Joint limits:** `ARM -upper_joint_bound/-lower_joint_bound`, in radians.
- **Absolute Accuracy corrections:** `ARM_CALIB -error_offset_*`, `-error_roll/pitch/jaw` and `-error_length`, all sub-millimetre, plus compliance terms.

An offline ABB model can therefore only be the published nominal one. Only the controller itself, through RWS or RAPID, includes the Absolute Accuracy corrections.

**Published coverage of the fleet in those backups.** This comes from the collection in `C:\Git Lab Repos\kinematics-reference`:

| Robot | What's published |
|---|---|
| IRB 6700-235/2.65 | Exact ROS-Industrial URDF |
| IRB 6700-175/3.05 | Third-party only, unverified |
| IRB 6700-220/2.65 LeanID | Nothing; nearest is 235/2.65 |
| IRB 8700-630/3.50 LeanID | Nothing reliable |

### 2. RAPID

`CalcJointT` and `CalcRobT` in a helper routine are exact, but they need a RAPID task or service routine.

### 3. Published models

`abb_irb6700_support` in https://github.com/ros-industrial/abb has the IRB 6700 200/2.60 and 235/2.65 variants only. The 300/2.70 dimensions would have to come from ABB's product specification.

## Suggested order

1. **FANUC offline forward and inverse kinematics from `symotn.va`.** It is pure TypeScript and testable against the corpus. The J2/J3 sign gets pinned with a recorded CURPOS reading.
2. **ABB through the RWS actions**, as part of the phase 4 connector.
3. **FANUC controller-side KAREL**, if the offline model disagrees with the pendant on calibrated robots.
