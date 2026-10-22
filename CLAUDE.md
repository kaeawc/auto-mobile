# AutoMobile

Node TypeScript MCP server providing Android Debug Bridge (ADB) capabilities through MCP tool calls for device automation.

## Key Rules

- TypeScript only (no JavaScript) for application code. The one exception is
  lint tooling: `oxlint-plugins/auto-mobile.mjs` (oxlint's plugin API is
  JS-first), as `eslint.config.mjs` was before it. Every rule in it is covered by
  the fast unit tests under `test/lint/`.
- Write GitHub issue and pull request references as clickable Markdown links only
  in AI-authored prose a human reads directly — issue and PR bodies, review
  comments, commit messages, and assistant chat responses — where a clickable
  link genuinely aids navigation for the reader. Do NOT require links in
  checked-in repository content: neither source code comments (bare `#NNNN` is
  the established convention — `src/` references are bare, never linked) nor Markdown
  documentation files (under `docs/` and elsewhere), where bare `#NNNN` is
  likewise fine. Forcing explicit links into committed files renders as noise in
  an editor and makes the touched file the only inconsistent one. Automated
  reviewers (e.g. Codex) must NOT flag bare `#NNNN` references that appear in
  source-code comments or Markdown files; treat those as compliant.
- After implementation changes, run relevant validation commands
- Before pushing shell/scripts changes, run `scripts/prepush-shell.sh` and `bun run format` (the formatter catches Fast Validation fan-out); if `bun.lock` and/or `package.json` changed in the diff, run `bun scripts/release/pin-runtime-deps.ts --write` and commit `package.json`, `bun.lock`, and `scripts/release/runtime-graph.json`; otherwise rebase onto current main and do not hand-edit pins to mask a stale base; never run two `bats test/bats/` sweeps concurrently on one machine; when an Actions API job log is empty, read the `fast-validation-logs` workflow artifact's per-check `.status`/`.log` files under `scratch/fast-validate-*/`.
- Use `scripts/prepush.sh` to select and run the relevant per-lane pre-push gates.
- Changes to `package.json` or `bun.lock` select runtime-pins, node, and integration lanes; runtime-graph input changes also require `scripts/prepush-integration.sh`.
- Write terminal output to `scratch/` when not visible
- Local validation scripts live under `scripts/` and should almost always be written in bash with shellcheck validation
- Run `scripts/prepush-android.sh` from the repository root before pushing changes under `android/`; its scoped Detekt pass is a smoke check, not a substitute for the full-tree CI Detekt job.
- For Playground/JUnit-runner emulator CI red (on PRs both suites run in the one `Run Android Emulator Tests` job, `scripts/android/run-emulator-suites.sh`), inspect `.github/actions/android-emulator` boot diagnostics first: no runner-health means an infra/runner-health question, while booted tests that fail are a regression.
- Copy `android/local.properties` from a working checkout into each new Android worktree; it is gitignored and required for Gradle SDK resolution.
- Ktfmt normalizes `runCatching{}.getOrNull()` to `runCatching {}.getOrNull()` once; write the spaced form and do not mistake that first rewrite for a non-idempotent formatter.
- Before adding a helper, parser, or dependency, search `src/`, `scripts/lib/`, `package.json`, and the runtime standard library. Prefer the standard library, then an existing direct dependency, then an existing repository helper, then a small tested helper. Do not parse JSON, YAML, XML, or TypeScript with line regexes when a structured parser or typed module contract exists. For new packages, state which built-in and installed alternatives were checked. Preserve injected interfaces/FakeTimer seams where tests need deterministic control.
- Always use interfaces & fakes & FakeTimer to decouple implementations and keep tests extremely fast and non-flaky
- Unit tests should pass in 100ms or less. Do not assume that a failing test can be allowed to fail. CI enforces this per test from the JUnit reporter's time (which excludes `beforeAll`); a test over budget is re-run in isolation and only its MEDIAN is failed, so a genuine breach must be fixed in the test, never by raising `BUN_TEST_MAX_MS`. The isolated re-runs run serially after all shards, each bracketed by a calibration probe (`runner-calibration.ts measure`); a run whose probe reads above `BUN_TEST_TIMING_CONTENTION_SLOWDOWN` (1.5x) AND whose sample is over budget is retried up to `BUN_TEST_TIMING_CONTENTION_RETRIES` (2) times, only while the remaining recheck budget still covers one attempt for every run left to verify, and the least-contended attempt is kept (an under-budget sample is conclusive and never retried). Samples are never scaled, so a slow test still fails on a contended runner; the summary reports the probe slowdown beside each verdict and flags any shard with `BUN_TEST_TIMING_CONTENDED_SHARD_MIN` (10) over-budget first samples as "Runner contended".
- One canonical primitive per concern: UUIDs come from `IdGenerator`, randomness from `Random` (`pick`/`next`), backoff from `Backoff`. Inject these (interface + fake) rather than spawning a new `randomUUID()`/`Math.random()` path.
- Prefer narrow interfaces that expose exactly what consumers need (YAGNI); grow the interface when the second consumer arrives, not ahead of need.
- Unit tests must never resolve the real file-backed `getDatabase()`. Under `bun test`, `NODE_ENV=test` arms a guard that throws when a test resolves the default `~/.auto-mobile` DB (issue #3067). Inject an in-memory DB via `createTestDatabase()`, or use a helper: `test/helpers/navigationTestHarness.ts` (in-memory `NavigationGraphManager` singleton + telemetry spy), `test/db/inMemorySingletonDatabase.ts` (`:memory:` singleton for identity checks), or `test/helpers/tempFileDatabase.ts` (temp-dir file DB for real `getInstance`/`getInstanceForSession` semantics). Resolve `getDatabase()` lazily (a getter), never in a field initializer, so construction alone can't trip the guard. The test preload (`test/setup/testPreload.ts`) is for suite-wide telemetry neutralization, not DB guard arming.

# Error Handling Convention

Every `catch` block in `src/` must follow one of three strategies. Pick by the
caller's contract, not by local precedent. The building blocks already exist:
`ActionableError` (`src/models/ActionableError.ts`) and the shared `logger`
(`src/utils/logger.ts`).

1. **Throw a structured error** — for system/MCP boundaries and feature actions
   whose failure should surface to the client. Throw `ActionableError` with
   actionable context, or use `toActionableError(error, context)` to wrap an
   unknown caught value in one call:

   ```ts
   } catch (error) {
     throw toActionableError(error, "Failed to start Android screenrecord");
   }
   ```

2. **Log, then return a typed failure** — for diagnostic/best-effort paths that
   return a status object (e.g. `doctor` checks) instead of throwing. Log the
   underlying error _before_ returning, so there is a trace even when the user
   only sees a summarized message. Use `logger.warn` for unexpected failures —
   the default level is `INFO`, so `logger.debug` is **dropped** unless the user
   opted into debug logging, which defeats the trace:

   ```ts
   } catch (error) {
     logger.warn(`simctl check failed: ${errorMessage(error)}`, error);
     return { name: "simctl", status: "fail", message: "..." };
   }
   ```

3. **Log-and-continue (swallow)** — only for genuinely-expected non-errors
   (port probes, optional capability checks). Log at `debug` and add a one-line
   comment stating _why_ it is safe to swallow:
   ```ts
   } catch (error) {
     // Connection refused is expected when no emulator is on this port.
     logger.debug(`port ${port} probe failed: ${error}`);
   }
   ```

Never leave a `catch` body empty or a bare `return`/`return null` with no log —
lint allows it (`caughtErrors: "none"`), so this convention is the only backstop.

# Project Structure

This document summarizes the AutoMobile repo layout and where to find key components.

## Core Code

- `src/` - MCP server source code (TypeScript)
- `test/` - MCP server test code (TypeScript)
- `schemas/` - Generated schemas and tool definitions
- `dist/` - Build output

## Mobile Platforms

- `android/` - Android Kotlin Gradle project (apps, libraries, IDE plugin)
- `ios/` - Swift packages and Xcode projects

## Tooling and Automation

- `scripts/` - Local validation and utility scripts
- `benchmark/` - Benchmarks and baselines
- `docs/` - User and developer documentation

# Build & Validate TypeScript

Bun is the primary task runner for TypeScript tooling. Turborepo provides task caching.

```bash
turbo run build        # Compile TypeScript (cached)
turbo run lint         # Lint: auto-fix locally, check-only in CI (cached)
turbo run test         # Run all tests (cached)
turbo run lint build test  # Run all with caching + parallelism
bun test --bail        # Stop on first failure (no cache)
bun test <file>        # Run specific test file (no cache)
```

## Node Pre-push Gate

Before pushing Node/TypeScript changes, run `bash scripts/prepush-node.sh`.
Use `scripts/prepush.sh` (`--list` to preview, `--all`, `--changed`, or `--base`) to select per-lane gates from changed paths; per-lane scripts remain usable standalone and each records its own attestation, while the dispatcher does not.
Use `bash scripts/prepush-node.sh --changed` for the faster affected-unit-test
loop; early selection via `bun scripts/lib/affectedTests.ts` adds reference-only unit extras beyond Bun's import closure, affected safe integration coverage, and the cross-cutting source-scan tests in `test/always-run-tests.txt` (which always run, since moving code breaks them untouched); a unit cap fallback replaces the changed lane with the full unit lane and skips unit extras, while integration caps use the full safe lane. Formatting, typecheck, and lint intentionally remain full repository
gates. Typecheck and lint stay strictly serial and separate because oxlint 1.88's experimental `--type-check` and tsgolint diagnostics do not replace the fail-closed typecheck parser, TS2688/`@types/bun` guard, or separate src/test tsconfig projects. It also runs the tool-free TypeScript subset of CI Fast Validation
(`scripts/all_fast_validate_checks.sh --only ...`, ~10 s, including the offline
lychee pass when `lychee` is installed), repository lint tests, and, on Linux or with `--timing`, the
100 ms unit budget. The timing gate measures the unit lane's JUnit reports when
source or runtime inputs changed; changed test files alone are still re-run
individually. Changed mode without reports uses the timing validator's own
affected-test selection. The separate repository lint gate runs only
`test/lint/*.integration.test.ts` in full mode (unit files already run in the unit
lane); `--changed` runs the whole `test/lint/` directory only when branch,
worktree, or untracked paths touch `src/`, `test/`, `scripts/`, `oxlint-plugins/`,
`android/`, `ios/`, `docs/`, `skills/`, `schemas/`, `.claude/`, `.github/`, or root
`.oxlintrc.json`, `package.json`, `bun.lock`, `bunfig.toml`, `turbo.json`, or
`tsconfig*.json`. After that directory runs, affected unit and integration extras
omit `test/lint/` files already covered. Always-run unit extras still run when
that gate skips. Shell, Kotlin, Swift, docs-syntax, bats and Windows/macOS
matrix lanes are not covered: use `scripts/prepush-shell.sh` and the platform
gates, and expect CI to be the only Windows run. `oxlint`'s actual exit code is authoritative: Error-level rules such as
`eqeqeq` are enforced directly by oxlint, not its warning-only ratchet, and
diffing warnings does not satisfy the gate. Before asking for a merge, fetch
`origin/main`, confirm the branch contains it, and re-run local gates.

Before pushing a contract or fake/interface change, also run
`bash scripts/prepush-integration-safe.sh`: it runs the whole safe tier of
`*.integration.test.ts` files in a fresh isolated temp dir, not just changed ones.
Classify every new integration test `safe` or `unsafe` in `test/integration-safe-tier.txt`
in the PR that adds it (a unit test enforces this), and `unsafe` files stay CI-only.

A 100ms unit timing overage on a loaded Linux runner may be rerun rather than
“fixed” when its isolated recheck is clean. Whether a given failure is a known
flake is decided by `scripts/ci/known-flakes.txt` (via
`bash scripts/ci/classify-failure.sh <run-id>`), not by this file. Do not treat
repeated cross-platform failures as a flake; refresh against main and identify
the shared failure first.

## Toolchain: TypeScript 7 (tsgo) + oxlint + oxfmt

Linting/type-checking/formatting run on the Oxc/TypeScript-7 toolchain, not
ESLint or `tsc`:

- **Type-check**: `tsgo` (`@typescript/native-preview`, the TS7 native compiler).
- **Lint**: `oxlint` with a custom JS plugin (`oxlint-plugins/auto-mobile.mjs`)
  for the repo's rules. Config in `.oxlintrc.json`.
- **Format**: `oxfmt` (`bun run format` to write, `bun run format:check` to gate).

`tsconfig.json` uses `module: ESNext` + `moduleResolution: bundler` (TS7 removed
the legacy `node10` that `"node"` aliased to; bundler also matches how bun
resolves this repo's extensionless imports and is the config `tsgolint` reads for
oxlint's `--type-aware` rules).

## Typecheck gates

Bun's bundler skips type-checking, so `build`/`test` do NOT catch type errors.
Two `tsgo --noEmit` passes run in CI (`scripts/typecheck-baseline.sh`):

```bash
bun run typecheck             # src (tsconfig.json): NO baseline, any error fails
bun run typecheck:test        # every test/**/*.ts (tsconfig.test.json): NO baseline, any error fails
```

Both baselines reached zero and were deleted (issues #3001, #11787): there is no
type-error baseline and no `--update` path, so any type error in `src/` or `test/` fails.
Both projects resolve `bun:*` modules and the `Bun` global from `@types/bun` via the
`types` list in their tsconfig; if it is missing the gate exits 4 on TS2688 / unresolved
`bun:` modules, so a broken install cannot pass silently. Run time is about 2 s (src) and
6 s (test). `as any` and `as unknown as` in `test/` are hard `oxlint` errors
(`auto-mobile/no-as-any`, `auto-mobile/no-unknown-cast`); the former test cast baselines
are deleted too. Fix the code (typed fakes, `Pick<>` views, `satisfies`, type guards).

## oxlint ratchet baseline

oxlint has no equivalent of ESLint's native bulk-suppressions file — only inline
`oxlint-disable` directives and whole-rule `--allow`. So the count-based ratchet
that gates NEW violations of rules the code predates is an external gate,
`scripts/oxlint-baseline.sh` (the lint equivalent of the typecheck baseline), with
its counts in `scripts/oxlint-baseline.txt`.

```bash
bun run lint            # auto-fix locally, check-only in CI, then ratchet/boundary gates
bun run lint:prune      # after FIXING violations: shrink the baseline
bun run lint:baseline   # alias of lint:prune (regenerate the baseline)
```

Everything in `.oxlintrc.json` set to `error` is gated directly by `oxlint` (its
exit code is authoritative; CI disables fixes so even auto-fixable violations
exit non-zero). `complexity`, `max-depth`, `max-params`, `max-lines-per-function`,
`max-classes-per-file`, `auto-mobile/max-class-lines` (1000 non-blank lines), and
`auto-mobile/catch-convention` are fully burned down and are `error` too, so the ratchet's
violation counts no longer cover them.
`typescript/no-floating-promises` and `typescript/no-misused-promises` are fully
burned down and are `error` in `.oxlintrc.json` (`no-floating-promises` covers `test/` too,
where a deliberately unawaited call is written `void`), but they need type information and
the fast stage is not type-aware, so they are enforced by the ratchet stage
(`oxlint --type-aware`), which keeps them in its gated codes at a zero baseline: any
diagnostic is a new violation and fails the gate (`--update` refuses to record one
without `--allow-grow`).
`auto-mobile/no-unknown-cast` and `auto-mobile/no-caught-error-interpolation` are
fully burned down and are `error` in `.oxlintrc.json`. Inline suppressions of ANY rule are ratcheted too: a
TypeScript-scanner comment scan (`scripts/lib/oxlintDisableScan.ts`) of every
file oxlint lints (repo-wide via `git ls-files`, TypeScript extensions only,
minus the `.oxlintrc.json` `ignorePatterns`) adds
`oxlint-disable(<rule>)` rows (`oxlint-disable-line(<rule>)` for the `-line` form; `oxlint-disable-block(<rule>)` for an unbounded disable a later enable closes, `oxlint-disable-partial(*)` for a bare disable only named enables partly re-enable, and `oxlint-disable-file(<rule>)` for one left open, so widening a suppression or dropping its closer is a new row (narrowing a baselined one, `-file` to `-partial` to `-block`, is a permitted shrink); and `oxlint-disable-no-reason(<rule>)` for
directives lacking a `-- reason`) to the same baseline, so a new
`oxlint-disable*`/`eslint-disable*` comment fails like a new violation and needs
`--allow-grow` even when it carries a `-- reason`; a new directive without a
reason additionally trips the no-reason row, so always write one. The baseline
is keyed per file + per rule with only a **count**, so it does not churn on line
shifts. Because the type-aware rules need type info, the ratchet script runs
`oxlint --type-aware` (tsgolint) — which is why the initial oxlint stage does not,
and CI type-checks only once. When you FIX violations, run `bun run lint:prune` and
commit the smaller file; the ratchet refuses to grow without `-- --allow-grow`.

The `scripts/lint.sh` script uses read-only `oxlint` followed by `oxfmt --check`
when `CI` is exactly `true` or `1`. All other values (including unset, empty, and
`false`) use `oxlint --fix` followed by `oxfmt --write`, even when oxlint fails,
so local autofix output is format-clean. In both modes oxfmt runs even after an
oxlint failure; the ratchet and both boundary gates run only when both stages
pass. CI therefore checks the committed tree without rewriting it. Turbo hashes
and forwards `CI` so local fix results cannot satisfy CI's check cache.
`bun run format:check` remains `oxfmt --check` in every environment.
Check mode skips `oxfmt --check` on Windows runners because CRLF checkouts would flag every file; formatting is gated by the `Check formatting` step of the Linux Fast Validation job and Linux/macOS lint.
`scripts/prepush-node.sh` inherits this mode: local runs fix, and `CI=true`/`1`
runs check only. `test/bats/lint-format-pipeline.bats` guards this contract.

Local `bun run lint` runs `oxlint --fix`, so only **non-auto-fixable** rules belong to
the ratchet — an auto-fixable one would rewrite `src/` on every local lint run. Keep each
ratchet rule as its own rule (the custom plugin already does) rather than folding
selectors into a shared one, so a baselined violation cannot be silently traded
for a genuinely-dangerous one.

Numeric thresholds (`complexity`, `max-depth`, `max-params`,
`max-lines-per-function` with blank lines and comments excluded,
`max-nested-callbacks`) live in `.oxlintrc.json`; read them there. `max-nested-callbacks`
and `auto-mobile/no-accumulator-foreach` (src/ only) must stay at zero baselined
violations. The full set the ratchet gates is listed above.

Explicit loops (`for`, `for-of`, `for-in`, `while`) are deliberately NOT linted.
The ratchet nudges toward declarative style where a clean declarative form
exists; it does not outlaw iteration.

## Zero baselines are deleted, not kept

When a ratchet baseline reaches zero, delete its baseline file, its regeneration
path (`UPDATE_*` env var, `--update`) and any allow-list plumbing, and make the guard
assert "no violations" outright (a warn-level oxlint rule becomes `error` and leaves
the ratchet's rule list in `scripts/oxlint-baseline.sh`). Named `EXEMPT_*` lists that
encode deliberate, reasoned exceptions are not baselines and stay. Import-direction
tiers follow the same rule: only tiers marked `baselined: true` in
`scripts/check-tier-import-direction.ts` keep a file under
`scripts/import-direction-baselines/`; `scripts/check-utils-import-direction.ts` has
no baseline at all.

## DaemonState.getInstance() guard

`test/lint/daemonStateGetInstanceRatchet.test.ts` parses `src/` and fails on any
`DaemonState.getInstance(` call outside its named `EXEMPT_FILES` (#11806). The
baseline reached zero and was deleted; pass the daemon state in as a dependency.

## File-backed DB lifecycle tests

Any test suite that opens a real `auto-mobile.db` (module close/reopen, migration
lifecycle, path resolution) MUST go through the shared
`createFileBackedDbHarness()` in `test/db/withFileBackedDb.ts` — never hand-roll a
`mkdtemp` + raw `import("database.ts?...")` + env restore. The harness centralizes
the four-part Windows-flake-avoidance pattern (fresh isolated module import,
tracked temp dirs cleaned with the bounded `removeTempDbDir`, `getDatabase()` then
`await ensureMigrations()` before close, and the `WINDOWS_FILE_DB_TEST_TIMEOUT_MS`
ceiling). Use `openLifecycleTestDb(prefix)` for the common open→migrate→close flow;
use the `makeTempDbDir` / `importFreshDatabaseModule` primitives for suites that
must control the migration lifecycle mid-flight. `:memory:`-backed suites (e.g.
`dbWriteBarrierResetOnClose`) are deliberately exempt — they carry no file handle.

# Validate Shell Scripts

Shell scripts under `scripts/` are tested with [BATS](https://github.com/bats-core/bats-core) and linted with shellcheck.

```bash
bats test/bats/        # Run all BATS shell tests
shellcheck scripts/**/*.sh  # Lint shell scripts
```

# MCP Tools Reference

The tool list is generated, not hand-copied: `schemas/tool-definitions.json` is the
authoritative set of MCP tool names and schemas (regenerate it with
`bash scripts/update-tool-definitions.sh`). Tool families: observation (`observe`),
interaction (tap/swipe/drag/pinch, key and text input, clipboard), app management
(launch/terminate/install/uninstall), and device management (list/provision/kill
devices, set the active device).

## Android Lint

Run `cd android && ./gradlew lintDebug --continue`. The Android pre-push gate
runs lint for affected modules (all modules for Gradle/build-logic changes);
the CI Detekt job runs it for every Android module. New warnings fail the build.
Remaining findings live in each module's `lint-baseline.xml`; clean modules have
no baseline. Baselines may only shrink, both in total and for each issue id per
module. After fixing a module, remove its baseline and regenerate with
`./gradlew :<module>:lintDebug -Dlint.baselines.continue=true`. Keep the generated
file only if nonempty, then run `./gradlew :<module>:lintDebug --rerun-tasks` once
to refresh AGP's cached baseline creation result. Never use `--allow-grow` when
updating baselines. `scripts/android/check-lint-baseline-shrink.sh` checks
HEAD against the merge-base with origin/main; pre-push includes local edits too.
Checks that compare against what is published upstream (AndroidGradlePluginVersion,
GradleDependency, NewerVersionAvailable, OldTargetApi) are disabled in the
convention plugins: their findings change over time and cannot be baselined.
Lint must never rewrite files (no autofix); a clean `git status` after a lint run
is the check.

# Android Notification Group Handling (Hard-Won Knowledge)

When Android collapses 2+ notifications from the same app into a group,
you **must expand the group before tapping** a specific notification.
Tapping a notification inside a collapsed group opens the app generically
instead of triggering the notification's deep-link intent.

The `systemTray` tool handles this automatically. See
`docs/design-docs/plat/android/system-tray-lookfor.md` for full details.

## What does NOT work (do not retry these approaches)

- **Tapping text nodes inside collapsed groups** — Android routes the tap
  to the group header, opening the app generically.
- **Swiping on the group** — `adb shell input swipe` does not expand
  collapsed notification groups.
- **Tapping the expand button without identifying the correct group node**
  — the tap is intercepted by the parent notification row.
- **Matching without expansion** — even with correct text matching, the
  tap target is not clickable until the group is visually expanded.

## What works

1. Match notification text inside the collapsed group hierarchy.
2. Detect the match is inside a group (via `groupNode` reference).
3. Find and tap the "Expand" button (`content-desc: "Expand"` or
   `resource-id` containing `expand_button`).
4. Wait 500 ms for UI to settle.
5. Re-observe and re-match the now-expanded notification.
6. Tap the specific notification row.

## CtrlProxy visibility bypass

The extractor does not filter on `isVisibleToUser` for any package (see
`android/control-proxy/src/main/kotlin/dev/jasonpearson/automobile/ctrlproxy/ViewHierarchyExtractor.kt`).
Collapsed groups mark child text nodes as not visible even though they are
present in the shade; ignoring this flag keeps those children matchable.

# CI failure triage

The `green-main` ruleset requires more status checks than the three
roll-up gates to merge, not just the three
roll-up gates. The ruleset is the only authoritative list (deliberately not
copied here, so it cannot rot): `gh api repos/kaeawc/auto-mobile/rulesets`, then
`.../rulesets/<id>` and its `required_status_checks` rule. The roll-up gates
(`IDE Plugin`, `iOS Build`, `Shell Tests`) only give a required context a stable
name over matrix or skipped jobs; every other required check is an ordinary job
that reports directly, so read that job. "Advisory" means not in the ruleset: it
never blocks a merge. Runs from before the `iOS`, `Android`, `Node Tests`, and
`WebRTC` roll-ups were removed may still show them red.
`bun scripts/ci/ci-time-to-green.ts` reports time-to-green against the live
required list. The `CI time-to-green report` workflow
(`ci-time-to-green-report.yml`) publishes the last 24 hours of PR runs daily as
its job summary and a 90-day artifact. Run
`bash scripts/ci/classify-failure.sh <run-id>` before retrying or changing code;
it identifies the specific upstream job and consults
`scripts/ci/known-flakes.txt`. Do not re-fix documented non-fixes. Before
pushing integration-test or runtime-graph input changes, run
`bash scripts/prepush-integration.sh`.
See `skills/ci-failure-triage/SKILL.md` for the full workflow.

# Version Control: jj colocated checkouts

If a `.jj/` directory exists at the repo root, this checkout is managed by
jj (Jujutsu), colocated with git. Use jj for all history-mutating VCS work;
plain `git` stays fine for read-only queries (`git log`, `git diff`, `gh`).

- Do NOT run mutating git commands (`git commit`, `git rebase`, `git stash`,
  `git checkout <branch>`) — they fight jj's working-copy snapshotting.
- Command mapping: status `jj st` · diff `jj diff` · commit `jj commit -m`
  (or `jj describe -m` + `jj new`) · amend `jj squash` · rebase
  `jj rebase -d main` · undo anything `jj undo`.
- PR flow: `jj bookmark create work/<name> -r @-`, then
  `jj git push --allow-new --bookmark work/<name>`, then `gh pr create`
  as usual. Update a PR by editing the change and `jj git push`.
- Git hooks do not run under jj. Always run the relevant validation
  commands (`turbo run lint build test`, `scripts/all_fast_validate_checks.sh`)
  before pushing — nothing else will.
- **Never add or modify binary assets** (images, video, fonts, archives —
  anything `.gitattributes` routes through LFS) in a jj checkout: jj bypasses
  git's LFS filters and would commit the full blob. `snapshot.auto-track`
  leaves such files untracked on purpose; do not `jj file track` them. Do
  asset work from a plain-git LFS-enabled clone. CI (`lfs-pointers` in Fast
  Validation) rejects violations.
- Do not create `git worktree`s of a jj checkout. For parallel work use
  `jj workspace add ../<name>` instead.

## iOS/Swift CI

- Before pushing a Swift change, run `scripts/prepush-ios.sh` (pinned
  SwiftFormat at the version pinned in `scripts/swiftformat/swiftformat_version.sh`, SwiftLint error rules, XCTestRunner build, and pure unit
  tests).
- `XCTestRunner Simulator Tests` is advisory, not required, and runs nightly or
  on a PR labelled `run-ios-sim` (`xctestrunner-simulator-tests.yml`). Read the exact job
  log and classify before rerunning (`bash scripts/ci/classify-failure.sh <run-id>`);
  known simulator-lane flake signatures live only in `scripts/ci/known-flakes.txt`.
- A simulator UDID belongs to exactly one CI job and is used serially there;
  never share a simulator between parallel runners or jobs.
- Re-run CI on the latest main base before merge; stale-base runs can mask a
  temporary main-red window.
- The nightly advisory `XCTestRunner Thread Sanitizer` job runs on CircleCI's
  `nightly-macos` workflow (`.circleci/continue_config.yml`, #11010); its
  `terminal` requirement means no later job depends on its result, and it needs
  no simulator. It catches
  #6061-style hangs with exit 124 naming the last started test, using the same
  simulator-free filter as `prepush-ios.sh` via
  `scripts/ios/xctestrunner_test_filter.sh`. Run locally with
  `bash scripts/ci/xctestrunner-tsan.sh`; logs are in `scratch/xctestrunner-tsan/`.

## Manual Linux qualification

`.github/workflows/linux-qualification.yml` is a manual-only Linux research run
for real procfs fixtures and the emulator SIGSEGV GPU/workload matrix. Its tested
bash entrypoints live in `scripts/ci/linux-qualification/`; see
`scripts/README.md` for evidence formats and bounds. Never dispatch it as part of
local validation; use `test/bats/linux-qualification-*.bats` with stubs instead.
