# macOS-only (iOS) unit and integration tests

Owner rule (2026-10-23): iOS tests never run on Linux or Windows. This page
describes the one classification that enforces the rule, instead of a guard in
each test file.

## Mechanism

- `test/macos-only-tests.txt` is the classification. A `macos` or `portable`
  rule, each with a reason, can override the default; the first matching rule
  wins.
- Default: a test whose path has an iOS token (`ios`, `simctl`, `devicectl`,
  `simulator`, `xcode`, `xcodegen`, `xcodebuild`, `xcrun`, `xctestrunner`, as a
  directory or camelCase word) is macOS-only. Everything else runs everywhere.
  Words such as `scenarios` or `getApple` do not match.
- `scripts/lib/macOsOnlyTests.ts` applies the classification from the path and
  the manifest only, never the test contents, so `scripts/test-ts.sh` can ask it
  cheaply.
- `scripts/test-ts.sh` skips macOS-only files whenever the host is not macOS:
  `unit`, `changed`, `integration`, `coverage` and the randomized nightly lane.
  macOS hosts run every file. `AUTOMOBILE_MACOS_ONLY_TESTS=include` runs them
  anywhere and `skip` drops them even on macOS (to reproduce a Linux lane).
  - Lanes that hand Bun an explicit file list (sharded Linux unit lanes, the
    per-file CI integration loop, randomized nightly, coverage) drop the skipped
    files from that list. The skip list is read once at lane start from
    `scripts/lib/macOsOnlyTests.ts list`; an unreadable classification fails the
    lane rather than guessing.
  - Lanes where Bun finds files itself (Windows shards, `--changed`, the
    integration filter) get `--config=scratch/bunfig.macos-only.toml`, a copy of
    `bunfig.toml` whose `pathIgnorePatterns` also lists the macOS-only files. Bun
    lets an ignore pattern win over an explicit file argument, and a config file
    has no command-line length limit, which a list of ~280 paths would hit on
    Windows.
  - Explicit targets (`test-ts.sh unit test/utils/ios-cmdline-tools`) drop the
    skipped files, and exit 0 when none remain.
- Each skipping lane prints a count line and, in CI, appends a "macOS-only (iOS)
  test files skipped" section to the job summary.

## What stays portable

Classify by what the test needs, not by its name. Keep a path-token test
running everywhere (`portable` rule) when it:

- scans repository files, workflows or generated sources (`test/lint/**`,
  `test/scripts/**`, drift guards);
- covers shared parsers, tool schemas, or broker, pool and registry logic that
  serves both platforms with iOS as one case;
- pins Android behavior beside the iOS case in code both platforms share (for
  example `TapOnElement.iosClippedTargetOwnership`), or classifies device ids that
  also cover Android serials;
- tests a fake that platform-neutral suites also use.

When unsure, keep the test running.

## Guard

`test/lint/macOsOnlyTestClassification.integration.test.ts` fails when:

- a test whose direct runtime imports of `src/` are only iOS source (apart from
  models, constants and a few leaf utilities) has no rule in the manifest. Add
  `macos` (needs an iOS host) or `portable` (cross-platform logic) with a reason;
- a rule matches no test file, or a `macos` rule covers files that already carry
  an iOS token, or a `portable` rule covers files that already run everywhere.

`test/scripts/macOsOnlyTests.test.ts` unit-tests the tokenizer, the manifest
parser, the classification order and the bunfig writer.

## Coverage on macOS

No pull-request lane runs these files after this change. The Linux and Windows
PR lanes skip them, and there is no macOS PR unit lane. They still run in the
nightly CircleCI `macOS Node Unit Tests` and `macOS Node Host Integration Tests`
jobs and in any local run on a Mac (`scripts/prepush-node.sh`), so an iOS
regression in this code is caught a night late at worst. A PR lane that runs only
the macOS-only subset on a Mac runner would close the gap; it is not part of
this change.
