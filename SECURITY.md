# Security

## Reporting a problem

Please report security problems privately, not as a public issue: use **Report a vulnerability**
on the repository's Security tab (GitHub private vulnerability reporting). Say what you found,
how to reproduce it, and which version you used. You will get an answer within a week.

Problems that matter most here are anything that could change a robot controller without the
user's say-so, send controller credentials somewhere unexpected, or run code from an untrusted
folder.

## What the extension does to keep controllers safe

- Nothing talks to a controller until robot connections are switched on, and an untrusted folder
  cannot switch them on, choose controllers or point the extension at other tools.
- Writes to a real controller are off until allowed on that PC, and every write is confirmed
  in a dialog that names the controller; the highest-consequence ones ask for its name to be typed.
- Passwords and PINs are kept in VS Code's secret storage and are sent only to the address they
  were saved for. Controllers are told apart by their own identity, not their address.
- The extension sends no telemetry.

## Supported versions

Only the latest release on the Marketplace gets security fixes.
