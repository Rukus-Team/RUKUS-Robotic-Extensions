# Seti, vendored

The built-in VS Code icon theme "Seti (Visual Studio Code)", copied unchanged from
`resources/app/extensions/theme-seti` of VS Code 1.138.0 on 2026-09-21:

- `seti.woff` - the icon font
- `vs-seti-icon-theme.json` - its file-extension / file-name / language-id tables
- `ThirdPartyNotices.txt` - the MIT licence of Seti UI (Jesse Weed), which covers both

`scripts/make-file-icons.mjs` merges the FANUC icons over these tables to make the "Robot Code"
file icon theme (`media/file-icons/robot-code-icon-theme.json`). Seti is what a fresh VS Code
shows, so switching to the Robot Code theme costs no other file its icon. To refresh: copy the
three files from a newer VS Code and run the generator.
