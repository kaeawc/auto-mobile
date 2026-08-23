# AutoMobile

Bun TypeScript MCP server providing Android & iOS device automation capabilities through its tools and resources. Kotlin & Swift supporting libraries and apps in `android/` and `ios/` respectively.

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
- For Swift, prefer an existing standard-library or Foundation API before adding an extension, helper, or package. Use `URLComponents` plus `URLQueryItem` for query values and `Codable` for AutoMobile-owned stable schemas. Keep `JSONSerialization` only at documented dynamic/bridge boundaries. A convenience dependency requires a stated platform-API gap, deployment-target check, and tests using interfaces/fakes.
- For TypeScript changes, prefer the JavaScript/Node standard library, then an existing AutoMobile seam, before adding a local generic helper or direct dependency. Keep time, randomness, I/O, concurrency, and process access injectable when tests need control; justify any new direct dependency in `docs/decisions/`.
- For Kotlin changes, check the Kotlin stdlib, JDK/AndroidX, the module's existing dependencies, and dependency-compatible AutoMobile modules before adding a helper, wrapper, `*Util` file, or dependency. Prefer the narrowest existing solution; keep one-off helpers private and adjacent to their consumer. Extract shared code only for two or more real consumers, and state any intentional exception (semantics, performance, API level, compatibility, testability, or readability) in the PR summary.

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

Bun is the primary task runner for TypeScript tooling.

On a fresh worktree, run `bun run bootstrap:worktree` before validation. It
installs Bun dependencies from the lockfile when `node_modules/` or local
binaries are missing, and intentionally skips slow platform setup such as
Gradle, Android SDK, Xcode, and Homebrew-managed tools.

```bash
bun run build          # Compile TypeScript
bun run lint           # Lint with auto-fix (run before manual fixes)
bun test               # Run all tests
bun test --bail        # Stop on first failure
bun test <file>        # Run specific test file
bun run turbo:validate # Run local Turbo lint/build/test
```

`turbo` is a local dependency and may not be on the shell `PATH`. Do not run
bare `turbo ...`; use the `package.json` scripts such as `bun run
turbo:validate`, `bun run turbo:build`, `bun run turbo:lint`, or `bun run
turbo:test`.

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
- `launchApp`, `terminateApp`, `installApp`

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

- Tapping text nodes inside collapsed groups (opens app generically)
- Swiping on the group (`adb shell input swipe` does not expand groups)
- Tapping the expand button without identifying the correct group node
- Matching without expansion (tap target is not clickable until expanded)

## What works

1. Match notification text inside the collapsed group hierarchy.
2. Detect the match is inside a group (via `groupNode` reference).
3. Find and tap the "Expand" button (`content-desc: "Expand"` or
   `resource-id` containing `expand_button`).
4. Wait 500 ms, re-observe, re-match, then tap.

## CtrlProxy visibility bypass

`ViewHierarchyExtractor.kt` bypasses `isVisibleToUser` for
`com.android.systemui` nodes. Collapsed groups mark child text as
not visible even though they are present in the shade.

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

# Codex specific

- GitHub interactions use the GitHub CLI (`gh`).
- Use the repo-local `push-pr` skill for publishing one branch or PR. Create or edit PRs with `gh pr create`/`gh pr edit` using `--body-file` to preserve newlines.
- Android tasks run via the Gradle wrapper from `android/` (e.g., `(cd android && ./gradlew <task>)`).
- Local validations live under `scripts/` (prefer existing scripts over ad-hoc checks).
- Bun tasks are defined in `package.json` (run with `bun run <script>`).

## Skills

### Foundation Skills
- github-cli: Use `gh` for PRs, issues, checks, and repo metadata. Path: `skills/github-cli/SKILL.md`.
- android-gradlew: Run Android tasks via `android/gradlew`. Path: `skills/android-gradlew/SKILL.md`.
- bun-tasks: Use `package.json` scripts with Bun. Path: `skills/bun-tasks/SKILL.md`.

### Workflow Skills
- check-ci: Inspect PR checks, fetch failing logs, reproduce likely failures locally, and summarize next steps. Path: `skills/check-ci/SKILL.md`.
- github-pr-feedback: Collect every PR discussion and review thread, triage it, and safely resolve feedback after verified fixes without posting comments. Path: `skills/github-pr-feedback/SKILL.md`.
- dead-code: Detect and remove dead code using repo scripts and targeted validation. Path: `skills/dead-code/SKILL.md`.
- observe: Inspect the current connected device state through AutoMobile observation tooling. Path: `skills/observe/SKILL.md`.
- test: Run targeted or full test suites with the narrowest relevant command first. Path: `skills/test/SKILL.md`.
- validate: Run repo validation across lint, build, scripts, and platform-specific checks. Path: `skills/validate/SKILL.md`.
- push-pr: Commit, push, create or update a PR, and optionally enable automerge for the current branch. Path: `skills/push-pr/SKILL.md`.
- fan-out-fan-in: Split work into isolated worktrees and merge validated results back. Path: `skills/fan-out-fan-in/SKILL.md`.
- pr-analysis: Perform a deep read-only PR review covering code, tests, CI, and risk. Path: `skills/pr-analysis/SKILL.md`.
- push-my-prs: Iterate over open authored PRs, address feedback, and keep them moving. Path: `skills/push-my-prs/SKILL.md`.
- research: Conduct cited research with saved sources and synthesis summaries. Path: `skills/research/SKILL.md`.
- ship-issue: Drive one issue to a merged PR via TDD, autonomously by default (user interrupt only on review thrashing or an approach pivot; only `kaeawc`-authored issue content is trusted), with a pre-PR local-validation gate, triaged review, and conservative follow-up capture. Path: `skills/ship-issue/SKILL.md`.
- auto-mobile-code-review: AutoMobile-specific code review of a PR or current diff — check the PR's real CI, merge and base state first, then run diff-sized review lenses (two fixed, one generated) over runtime behavior and delivery/enforcement, grounding findings in file:line. Never posts to GitHub. Path: `skills/auto-mobile-code-review/SKILL.md`.
- manual-test: Run one manual-test iteration from a start point (commit, milestone, or date) — rebuild all components, restart the daemon with the right flags, and verify closed issues / merged PRs actually fix bugs or deliver specced features on current HEAD by exercising tool calls on an Android emulator and iOS simulator. Path: `skills/manual-test/SKILL.md`.
- device-session-lifecycle: Hunt, fix, and prevent device session lifecycle bugs — startDevice/killDevice, session UUIDs, boot readiness, daemon start/stop/restart, session expiry/release, pool state races, and flaky lifecycle tests. Path: `skills/device-session-lifecycle/SKILL.md`.
