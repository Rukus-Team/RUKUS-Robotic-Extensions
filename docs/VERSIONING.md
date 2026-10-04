# Version ids - how to read one and how to make one

Since 2026-09-22 a Robot Code version is a **version id** in the same shape RUKUS uses. It does
not count builds. It tells you what the work was, which issue it belongs to and when it started -
or, for a release, which release of the month it is.

There are two kinds of build, and they live on one number line so an updater can compare them:

```
a working build      26 . 91 . 21010
                      │    │    └──── DDIII  the day the work started, then the issue number
                      │    └───────── MT     the month the work started, then the change type
                      └────────────── YY     the year the work started

a release            26 . 99 . 1
                      │    │    └──── N      the release number within the month (1, 2, 3 ...)
                      │    └───────── M9     the month, then 9 - the release type
                      └────────────── YY     the year
```

`26.91.21010` is a **feature** (type 1), for **issue #10**, started on **21 September 2026**.
`26.99.1` is **September 2026's first release**.

RUKUS uses the same shape, and both fit every number under 65536, which Windows demands of a
file version. Before this (2026-09-19 to 09-22) the first form was `26.9.21010` for the extension
and `26.9.13026.1` for RUKUS, the type as a fourth number the extension could not carry. The tool
still reads those.

## Reading one

1. **`26`** is the year.
2. **`91`** is the month and the change type run together. Peel off the **last digit**: that is
   the type. What is left is the month. `91` is September, feature. `101` is October, feature.
   `19` is January, release.
3. **`21010`** is the start day and the issue number run together. Peel off the **last three
   digits**: `010` is issue #10. What is left is the day: 21. For a release this number is just
   the release number: `1`, `2`, `3`.

| Type | Means | Branch names that map to it |
|---|---|---|
| 1 | feature | `feature/`, `feat/` |
| 2 | bug fix | `fix/`, `bug/`, `bugfix/`, `hotfix/` |
| 3 | maintenance: refactors, build, tooling | `refact/`, `refactor/`, `chore/`, `build/`, `ci/`, `tools/`, `maint/` |
| 4 | docs | `docs/`, `doc/` |
| 9 | a release | not a branch - `npm run version:id -- --release` |

| Id | Reads as |
|---|---|
| `26.91.21010` | feature, issue #10, started 21 September 2026 |
| `26.92.19005` | bug fix, issue #5, started 19 September 2026 |
| `26.101.5026` | feature, issue #26, started 5 October 2026 |
| `26.99.1` | the first release of September 2026 |
| `26.109.2` | the second release of October 2026 |
| `27.11.5040` | feature, issue #40, started 5 January 2027 |

**Two things to watch.** A single-digit day has no leading zero: `5026` is day 5, issue 26, never
`05026`. And the second number is two or three digits: `91` is one month, `101` another. Always
peel the last digit (type) and the last three digits (issue) first; what is left is the month
and the day.

The tool reads an id back in words, in any of the forms:

```
node scripts/version-id.mjs --decode 26.91.21010
node scripts/version-id.mjs --decode 26.99.1
node scripts/version-id.mjs --decode 26.9.13026.1
```

```
  26.91.21010
    started 21 September 2026
    issue   #10
    type    1 feature
```

## Why this shape

- **Every number under 65536.** Windows stores each part of a file version in 16 bits, and RUKUS
  is a Windows program. `MT` never passes 129 and `DDIII` never passes 31999.
- **Valid semver.** Three plain numbers, no leading zeros. That is what a VS Code extension
  version has to be.
- **Sorts by time.** Year, month, then type, then day and issue. A release is type 9, so it is
  above every working build of its month, and next month's first working build (`26.101.1001`) is
  above it. An updater only offers a higher number; this is what makes it offer the release to
  someone on a dev build, and October's work to someone on September's release.
- **Both products, one shape.** RUKUS `26.91.13026` and extension `26.91.21010` read the same way.

What did not fit, and why: `26.9.0102614` (type, issue and day run together) is not semver and
102614 is past 65535. `year.type.issue+day` sorts by type before date, so a maintenance build
would always outrank a feature build. A release written as `.0` sorts *below* every working
build of its month, so nobody on a dev build would ever be offered it. And dropping the month
puts 1 October below 30 September.

## Making one

A working build's id is made from three facts: the **change type**, the **issue number** and the
**start date**. The tool finds all three.

- **Issue number** comes from the `#10` in the branch name. `fix/#5-smoke-findings` gives 5.
- **Change type** comes from the branch prefix when it is one in the table. `fix/` is 2. A prefix
  that is not in the table stops the tool, and you say `--type`.
- **Start date** is the date of the first commit on your branch that `main` does not have. On a
  branch with no commits yet it is today.

### Step 1 - look before you write

```
npm run version:id -- --show
```

```
  26.92.19005
    started  2026-09-19   (the first commit on 'fix/#5-smoke-findings' that origin/main does not have)
    issue    #5
    type     2 bug fix
```

Check the three lines. If one is wrong, override just that one:

```
npm run version:id -- --show --start 2026-09-20
npm run version:id -- --show --issue 31
npm run version:id -- --show --type feature
```

### Step 2 - write it

```
npm run version:id
```

This changes the one `"version"` line in `package.json` and nothing else. Then add a section to
`CHANGELOG.md` headed with the id, because the release script takes its notes from there:

```
## 26.92.19005 - 2026-09-19 - what this is
```

Then `npm run package`.

### A release

When what is on `main` goes out as a release, it gets a release id: the month's next number,
worked out from the tags already released.

```
npm run version:id -- --release           # 26.99.1 if September has had none, 26.99.2 after that
npm run version:id -- --release 2         # or say the number
```

Then a `## 26.99.1 - <date> - <title>` section in `CHANGELOG.md`, `npm run package`, and
`npm run release`.

## The rules that keep it working

**One issue is one working build.** The id has no build counter. Until a version is released you
can repackage it as often as you like under the same id. A follow-up after release is a new issue
with its own id.

**Every branch needs an issue and a type.** No `#NN` in the branch name and no `--issue` means
no id; no known prefix and no `--type` means no id. That is on purpose.

**Issue numbers stop at 999, release numbers too.** Three digits each.

**Inside one month, type orders before day.** A bug fix (`26.92.x`) is above every feature build
(`26.91.x`) of the same month whatever the days. Accepted: a month is short, and the release at
the end of it (`26.99.n`) is above them all.

**A working build's order follows the day the work started, not the day it ships.** The scheme
does not protect you from this on its own, so the release script does.

## When the release script says the version is not higher

RUKUS only installs the extension it bundles when that one is **newer** than the one already on
the PC. Ids are compared number by number, left to right.

Usually that matches the order things ship in. It stops matching when work that started early
ships late:

| | Issue | Started | Shipped | Id |
|---|---|---|---|---|
| A | #5, feature | 19 Sept | 20 Sept | `26.91.19005` |
| B | #1, feature | 18 Sept | 25 Sept | `26.91.18001` |

B ships after A, but B's id is **lower**, because the 18th comes before the 19th. Released like
that, RUKUS would never install B over A, and nothing would say why.

`npm run release` compares the version with every tag already released and refuses one that is
not higher. The message carries the fix:

```
release: 26.91.18001 is not higher than v26.91.19005, which is already released - RUKUS would never install it over that one.
  Re-stamp it with today's date, then package and release that:
    node scripts/version-id.mjs --start 2026-09-25 --type 1
```

The date in the message is worked out for you, and it is not always today:

- two ids with the same start day are ordered by issue number, so if what is already released
  *also* started today with a higher issue number, it is tomorrow;
- a released **bug fix** (`26.92.x`) is above every feature build of the month, so a feature
  behind it gets the **1st of next month**;
- a **release** (`26.99.n`) is above the whole month, so anything behind it gets the 1st of next
  month too. A month's release is meant to be the last thing out of that month.

**Re-stamp the work with the date the message gives**, package, and release that. The id then says
"started" on the day it was re-stamped. That is a small untruth in exchange for updates that work.

## Quick reference

| I want to | Run |
|---|---|
| See the id for the branch I am on | `npm run version:id -- --show` |
| Read an id back in words | `node scripts/version-id.mjs --decode 26.91.21010` |
| Write the id into `package.json` | `npm run version:id` |
| Use a different start date, issue or type | `npm run version:id -- --start 2026-09-20 --issue 31 --type bug` |
| This month's next release id | `npm run version:id -- --release` |
| Re-stamp work that came out lower | `npm run version:id -- --start <the date in the message> --type <its type>` |
| Check a release without doing it | `npm run release -- --dry-run` |

The change types live in three places that must agree: `TYPE_NAMES` / `TYPE_WORDS` in
`scripts/version-id.mjs`, and `Tools\version-id.ps1` and `docs\VERSIONING.md` in the RUKUS repo.
