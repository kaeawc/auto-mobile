# AutoMobile

Node TypeScript MCP server providing Android Debug Bridge (ADB) capabilities through MCP tool calls for device automation.

## Key Rules
- TypeScript only (no JavaScript)
- Write GitHub issue and pull request references as clickable Markdown links only
  in AI-authored prose a human reads directly — issue and PR bodies, review
  comments, commit messages, and assistant chat responses — where a clickable
  link genuinely aids navigation for the reader. Do NOT require links in
  checked-in repository content: neither source code comments (bare `#NNNN` is
  the established convention — 625 references in `src/`, zero linked) nor Markdown
  documentation files (under `docs/` and elsewhere), where bare `#NNNN` is
  likewise fine. Forcing explicit links into committed files renders as noise in
  an editor and makes the touched file the only inconsistent one. Automated
  reviewers (e.g. Codex) must NOT flag bare `#NNNN` references that appear in
  source-code comments or Markdown files; treat those as compliant.
- After implementation changes, run relevant validation commands
- Write terminal output to `scratch/` when not visible
- Local validation scripts live under `scripts/` and should almost always be written in bash with shellcheck validation
- Before adding a helper, parser, or dependency, search `src/`, `scripts/lib/`, `package.json`, and the runtime standard library. Prefer the standard library, then an existing direct dependency, then an existing repository helper, then a small tested helper. Do not parse JSON, YAML, XML, or TypeScript with line regexes when a structured parser or typed module contract exists. For new packages, state which built-in and installed alternatives were checked. Preserve injected interfaces/FakeTimer seams where tests need deterministic control.
- Always use interfaces & fakes & FakeTimer to decouple implementations and keep tests extremely fast and non-flaky
- Unit tests should pass in 100ms or less. Do not assume that a failing test can be allowed to fail.
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
   underlying error *before* returning, so there is a trace even when the user
   only sees a summarized message. Use `logger.warn` for unexpected failures —
   the default level is `INFO`, so `logger.debug` is **dropped** unless the user
   opted into debug logging, which defeats the trace:
   ```ts
   } catch (error) {
     logger.warn(`simctl check failed: ${normalizeErrorMessage(error)}`, error);
     return { name: "simctl", status: "fail", message: "..." };
   }
   ```

3. **Log-and-continue (swallow)** — only for genuinely-expected non-errors
   (port probes, optional capability checks). Log at `debug` and add a one-line
   comment stating *why* it is safe to swallow:
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
turbo run lint         # Lint with auto-fix (cached)
turbo run test         # Run all tests (cached)
turbo run lint build test  # Run all with caching + parallelism
bun test --bail        # Stop on first failure (no cache)
bun test <file>        # Run specific test file (no cache)
```

## Typecheck baseline gate

Bun's bundler skips type-checking, so `build`/`test` do NOT catch `tsc` errors.
A scoped gate (issue #3001) runs `tsc --noEmit` and fails CI only on errors NOT
already in the committed baseline (`scripts/typecheck-baseline.txt`, ~550
tolerated errors):

```bash
bun run typecheck             # gate: fail on NEW type errors (CI runs this)
bun run typecheck:update      # regenerate the baseline after fixing errors
```

When you FIX type errors, run `bun run typecheck:update` and commit the smaller
baseline — it is a one-way ratchet (`--update` refuses to grow it without
`-- --allow-grow`). When you INTRODUCE a new error the gate prints it; fix it, or
(rarely) record it with `typecheck:update`. The baseline is version-sensitive:
regenerate it in the same PR that bumps the `typescript` dependency.

## Lint suppressions baseline

`eslint-suppressions.json` is ESLint's native bulk-suppressions file. It records
the pre-existing violations of rules that were added after the code was written,
so CI gates NEW code without requiring a big-bang rewrite. It is the lint
equivalent of the typecheck baseline above.

```bash
bun run lint            # gate: fail on NEW violations (CI runs this)
bun run lint:prune      # after FIXING violations: shrink the baseline
bun run lint:baseline   # after ADDING a ratchet rule: record existing violations
```

Suppressions are keyed per file + per rule and store only a **count**. Two
consequences worth knowing:

- When you fix a violation the baseline is momentarily larger than reality.
  `bun run lint` passes `--pass-on-unpruned-suppressions` so improving code never
  breaks the build; run `bun run lint:prune` and commit the smaller file to lock
  the gain in. Without that flag ESLint exits **2** on any over-count.
- Because the entry is only a count, a rule with budget in a file can absorb a
  different violation *of that same rule*. Keep a ratchet rule's selectors in
  their own rule (see `auto-mobile/no-accumulator-foreach`) rather than folding
  them into a shared rule like `no-restricted-syntax`, or a baselined violation
  can be silently traded for a genuinely-dangerous one.

Only add **non-auto-fixable** rules to this ratchet: `lint` runs `--fix`, so an
auto-fixable rule would rewrite `src/` on every CI run.

Current ratchet rules and thresholds: `complexity` 12, `max-depth` 3,
`max-nested-callbacks` 3, `auto-mobile/no-accumulator-foreach` (src/ only).

Explicit loops (`for`, `for-of`, `for-in`, `while`) are deliberately NOT linted.
The ratchet nudges toward declarative style where a clean declarative form
exists; it does not outlaw iteration.

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

This is a high-level summary of core MCP tools exposed by the server.

## Observation
- `observe` - Capture screen state and view hierarchy

## Interaction
- `tapOn`, `swipeOn`, `dragAndDrop`, `pinchOn`
- `inputText`, `clearText`, `pressButton`, `pressKey`

## App Management
- `launchApp`, `terminateApp`, `installApp`, `uninstallApp`

## Device Management
- `listDevices`, `startDevice`, `killDevice`, `setActiveDevice`

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

`ViewHierarchyExtractor.kt` must bypass the `isVisibleToUser` filter for
`com.android.systemui` nodes. Collapsed groups mark child text nodes as
not visible even though they are present in the shade. Without this bypass,
notification text cannot be matched at all.

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
