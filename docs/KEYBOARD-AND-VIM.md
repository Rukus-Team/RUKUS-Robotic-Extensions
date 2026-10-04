# Keyboard shortcuts, and using Robot Code with Vim keys

**Ctrl+Alt+H** opens *What Can I Do Here?* - every feature, grouped, with its shortcut. That
picker reads the installed manifest, so it is always right; this page is the same list on paper.

Every shortcut is a default. Change any of them in **File > Preferences > Keyboard Shortcuts**
(search `Robot Code`), or from the last entry of the picker.

## The shortcuts

Anywhere in a robot file or with the Robot Code sidebar focused:

| Key | Does |
| --- | --- |
| Ctrl+Alt+H | What Can I Do Here? |
| Ctrl+Alt+N | New TP program (name, comment, type, group mask, write protect) |
| Ctrl+Alt+X | Register & I/O cross-reference report |
| Ctrl+Alt+A | Register & I/O table |

In a TP program:

| Key | Does |
| --- | --- |
| Ctrl+Alt+L | Go to label |
| Ctrl+Alt+F | Program flow (flowchart) |
| Ctrl+Alt+G | Call graph |
| Ctrl+Alt+P | Compare positions with another program |
| Ctrl+Alt+Shift+F | Fetch: read the open file from the robot into the snapshot (nothing changes on the robot) |
| Ctrl+Alt+Shift+D | Pull: fetch, then replace the local copy with the robot's (Ctrl+Z undoes) |
| Ctrl+Alt+Shift+U | Push: send the program to the robot - asks first, is refused if the robot changed since the snapshot, refuses a running program, reads it back |
| Ctrl+Alt+C | Compare with the robot's copy (connected, local file) |
| Ctrl+Alt+Shift+E | Live edit: pair the program with a robot, then every save is sent (click the status bar item to stop) |
| Ctrl+Alt+Shift+M | Combine programs into one, in the order you pick them |
| Ctrl+Alt+Shift+R | Toggle automatic renumbering |

In a TP program you can edit (these are off in a read-only file from a controller):

| Key | Does |
| --- | --- |
| Ctrl+/ | Toggle remark (`//`) on the selected lines |
| Ctrl+Alt+R | Renumber lines |
| Ctrl+Alt+Shift+L | Renumber labels (10, 20, 30…) |
| Ctrl+Alt+B | Insert comment banner |
| Ctrl+Alt+I | Insert program template at the cursor |
| Ctrl+Alt+M | Convert motion type J <-> L on the selected lines |
| Ctrl+Alt+E | Set termination (FINE / CNT) on the selected lines |
| Ctrl+Alt+V | Scale motion speeds on the selected lines |
| Ctrl+Alt+T | Teach position from the robot's current position |
| Ctrl+Alt+Shift+T | Record a NEW position from the current position |
| Ctrl+Alt+Shift+O | Offset positions |
| Ctrl+Alt+Shift+H | Mirror positions across a plane |
| Ctrl+Alt+Shift+C | Convert positions to another frame |
| Ctrl+Alt+Shift+P | Clean up unused positions |
| Ctrl+Alt+Shift+S | Compare positions with the snapshot (in a robot container) |

In a file that is on a controller: **Ctrl+Alt+W** downloads an editable copy.
In KAREL: **Ctrl+Alt+Shift+K** checks before compiling (lint plus the `%INCLUDE` check), **Ctrl+Shift+B** compiles with ktrans.

On a keyboard layout where **AltGr** is Ctrl+Alt (German, Spanish, Nordic…), some of these
collide with typing `@`, `{`, `[`. Rebind those; the US layout is not affected.

## Vim

**Status: tested with the Vim extension (`vscodevim.vim`) installed** - `npm run smoke:vim`
(issue #19). It installs Vim into a test profile of its own and checks:

- **Shortcuts:** none of Robot Code's 36 keybindings collides with any of Vim's 75 in a TP or KAREL
  editor. Robot Code never binds a plain key or a `Ctrl+letter`, the ones Vim owns; every default
  above is `Ctrl+Alt+…` (plus `Ctrl+/`), which Vim passes through in every mode.
- **Auto-renumber under real Vim keystrokes:** `o` + typing + `Esc`, `dd`, `p`, `.`, `yy P`, `3dd`,
  `u` and `Ctrl+R` - after each, the lines number 1..n and `LINE_COUNT` says n.

Two things the test found, both fixed:

- The line the cursor rests on was left unnumbered (or numbered twice) after `o … Esc`, `dd` or
  `p`, because renumbering leaves the line you are typing on alone. In Vim's Normal mode nobody is
  typing there, so that line is now renumbered too (Normal mode = Vim's block cursor; only when the
  Vim extension is running).
- `u` could never get past a renumber: Vim's own undo history does not know about edits another
  extension makes, so it took back only the renumber, which came straight back. Use VS Code's undo
  for `u` / `Ctrl+R` - **add this to `settings.json`** - and one `u` takes an edit and its renumber
  out together:

```jsonc
"vim.normalModeKeyBindingsNonRecursive": [
  { "before": ["u"], "commands": ["undo"] },
  { "before": ["<C-r>"], "commands": ["redo"] }
]
```

Go to definition, references, hover and rename are ordinary language features, so Vim's own
`gd`, `gh`, and `gr`-style mappings reach CALL targets, labels, `P[n]` and registers. Robot Code
does not ship Vim mappings of its own - the leader set below is opt-in.

If renumbering gets in the way of a long `.`/macro edit, set `robotCode.tp.autoRenumber` to
`scaffold` or `off` and press `<leader>rn` when you are done.

Leader mappings - paste into `settings.json` (leader shown as space); put the `u` / `<C-r>`
entries above into the same `vim.normalModeKeyBindingsNonRecursive` list:

```jsonc
"vim.leader": "<space>",
"vim.normalModeKeyBindingsNonRecursive": [
  { "before": ["<leader>", "?"],      "commands": ["robotCode.showFeatures"] },
  { "before": ["<leader>", "r", "n"], "commands": ["robotCode.tp.renumber"] },
  { "before": ["<leader>", "r", "l"], "commands": ["robotCode.tp.renumberLabels"] },
  { "before": ["<leader>", "g", "l"], "commands": ["robotCode.tp.gotoLabel"] },
  { "before": ["<leader>", "f"],      "commands": ["robotCode.tp.showFlow"] },
  { "before": ["<leader>", "c", "g"], "commands": ["robotCode.tp.showCallGraph"] },
  { "before": ["<leader>", "x"],      "commands": ["robotCode.tools.xrefReport"] },
  { "before": ["<leader>", "t"],      "commands": ["robotCode.tp.teachPosition"] },
  { "before": ["<leader>", "T"],      "commands": ["robotCode.tp.recordPosition"] },
  { "before": ["<leader>", "o"],      "commands": ["robotCode.tp.offsetPositions"] },
  { "before": ["<leader>", "d"],      "commands": ["robotCode.sync.compareFile"] },
  { "before": ["<leader>", "w"],      "commands": ["robotCode.live.downloadFile"] },
  { "before": ["g", "c", "c"],        "commands": ["robotCode.tp.toggleRemark"] }
],
"vim.visualModeKeyBindingsNonRecursive": [
  { "before": ["g", "c"],             "commands": ["robotCode.tp.toggleRemark"] },
  { "before": ["<leader>", "m"],      "commands": ["robotCode.tp.convertMotion"] },
  { "before": ["<leader>", "e"],      "commands": ["robotCode.tp.setTermination"] },
  { "before": ["<leader>", "v"],      "commands": ["robotCode.tp.scaleSpeeds"] }
]
```

These apply in every language, not only TP; in another file type the Robot Code commands say
"open a TP program first" and do nothing. The `gcc`/`gc` pair replaces Vim's comment toggle with
the TP remark toggle - leave those two lines out if you use `gc` elsewhere.

Worth deciding once it has been tried: whether Robot Code should ship these mappings itself
(an extension can contribute them only by writing the user's settings, which is why it does not).
