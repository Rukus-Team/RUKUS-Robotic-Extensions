# Design: Onboarding - walkthroughs, tutorial cell, and deep tutorials

> Status: **Implemented** (issue #44). Three walkthroughs, a bundled tutorial cell, a how-to
> layer, and a downloadable deep-tutorial bundle - designed against Diátaxis, cognitive-load
> research (worked examples / faded practice), NN/g progressive disclosure, and VS Code's own
> walkthrough UX guidelines.

## Why

The first walkthrough predated the container/snapshot model and the experimental gate, so it
taught the retired **Backup** view, claimed "nothing is ever written to the robot" (Push and
Upload write), and used retired verbs. Two of its completion events were broken: `onLanguage:`
is not a supported event, and one step completed on a view gated by the experimental switch it
was supposed to introduce - so it could never complete. A new user had no guided path at all
(`docs/ux-audit.md` §1, item 1b).

## The three walkthroughs

VS Code walkthroughs are a flat, ordered list with no branching and no top-level `when`, so
"tracks" are separate walkthroughs; a step's `when` gates only that step. Four tracks were
consolidated to **three** (VS Code: don't add multiple walkthroughs unless necessary):

| Walkthrough id | Title | Needs | Gating |
|---|---|---|---|
| `robotCode.gettingStarted` | Edit Robot Programs | nothing (offline) | always visible; `featuredFor: *.ls/*.kl/*.va` |
| `robotCode.robot` | Set Up a Robot | experimental switch | live steps `when: config.robotCode.experimental.robotConnections` |
| `robotCode.rukus` | Robot Code + RUKUS | RUKUS installed | steps 2+ `when: robotCode.rukusAvailable` |

**Robot-first.** Robot containers work standalone, and the live loop (snapshot, connect,
fetch/push, teach) is complete with one robot. Cell containers are **under development** and were
removed from the walkthroughs until RUKUS cluster integration makes them worth teaching; the
feature and its commands stay, documented in `docs/how-to/cell-containers.md`.

**RUKUS is optional** and external: detected by its data folder (`robotCode.rukusAvailable`) and
the `rukus://` protocol handler. Its first step explains that and offers the download; steps 2+
gate on availability, so the track never dead-ends.

### What each step carries (the research)

- **One verb action** - VS Code "provide actions (for example, View all Commands) for each step.
  Use verbs where possible"; Diátaxis "focus on the concrete".
- **A completion event** - every step is checkable, so the checklist metaphor holds.
- **A narrative of the expected** - each media file says **what you should see** (Diátaxis).
- **Minimal explanation** - the "why" is a link to `docs/`, not a paragraph in the tutorial.
- **A theme-aware image** where a picture beats words - SVG using `var(--vscode-*)` theme colours
  (VS Code "Do": images that work across themes). Concepts: sidebar anatomy, the snapshot model,
  the push gate, a flow chart.

## The tutorial cell

`samples/tutorial-cell/` ships in the VSIX (top-level, not in `.vscodeignore`) and is opened by
**Robot Code: Open the Tutorial Cell**:

- `.robocode-cell/cell.json` - a cell with two controllers, `S002R01` → 127.0.0.2 and `S002R05`
  → 127.0.0.3 (placeholders; nothing listens).
- Two robot containers, each with a snapshot; `S002R01/LS/LOAD.LS` differs from its snapshot (an
  extra `WAIT` line) and `S002R05/LS/PICK.LS` matches, so the sync markers show something offline.
- `S002R05/LS/BAD.LS` has an undefined label - the **faded practice** element (worked example →
  completion problem): the README says what to fix and what the result should look like.
- Register comments (`R[5] Part Count`) in `numreg.va`, and a small KAREL file.

**No administrator rights.** The command copies the sample to
`context.globalStorageUri/tutorial-cell` (under the user profile), falling back to the OS temp
folder, then opens it in a **new window** - the user's own work is never touched. An existing
copy offers **Open** / **Reset to a clean copy** rather than being overwritten.

## Entry points

- **Get Started page**: the three walkthroughs appear there.
- **Empty views** (`viewsWelcome`): **Try the Tutorial Cell** on Data / Snapshot / PC programs,
  **Set Up a Robot Walkthrough** on Controllers, the RUKUS walkthrough on Clusters.
- **What Can I Do Here?**: the three walkthroughs in its **More** section.
- **Initialize Robot Container** wizard: its success message offers **Open the walkthrough**.
- New commands: `robotCode.tutorial.open`, `robotCode.tutorial.openReadme` (opens the tutorial
  cell's `README.md` as a Markdown preview), `robotCode.experimental.enableRobotConnections`, and
  the three openers (`robotCode.openGettingStarted`, `.openRobotWalkthrough`,
  `.openRukusWalkthrough`) - the openers are link-only and hidden from the palette.

## The deeper layers

The in-editor walkthroughs stay basic. Depth lives in two places:

- **How-to** (`docs/how-to/`) - task recipes for the power tools and analysis (offset positions,
  frames, refactoring, analysis, pendant changes, cell containers). Repo-only, linked from README.
- **Deep-tutorial bundle** (`robot-code-tutorials-<version>.zip`) - five in-depth lessons, built by
  `npm run tutorial:bundle` (a dependency-free ZIP writer, `scripts/make-tutorial-bundle.mjs`) and
  attached to each GitHub release by `scripts/release.mjs`. `tutorial/**` is excluded from the VSIX.

`docs/README.md` is the map of all four document kinds (tutorial / how-to / reference /
explanation).

## Testing

`test/walkthrough.test.ts` holds the walkthroughs against the running manifest: the three ids
exist and are unique; every step's media file exists; every step has a `command:` action **and** a
completion event; every media file has an expected-result line; every `command:` link and
completion target resolves (built-ins via a small `workbench.`/`markdown.`/`vscode.` allowlist);
completion prefixes are supported (`onLanguage:` is rejected); SVGs exist and use only theme
variables or `currentColor`; the README's how-to links resolve; and the tutorial cell parses with
two controllers on 127.0.0.2 / 127.0.0.3, each robot bound to its controller, with one differing,
one matching, and the practice program present.
