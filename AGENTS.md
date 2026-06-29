# AutoMobile

Bun TypeScript MCP server providing Android & iOS device automation capabilities through its tools and resources. Kotlin & Swift supporting libraries and apps in `android/` and `ios/` respectively.

## Key Rules
- TypeScript only (no JavaScript)
- After implementation changes, run relevant validation commands
- Write terminal output to `scratch/` when not visible
- Local validation scripts live under `scripts/` and should almost always be written in bash with shellcheck validation
- Always use interfaces & fakes & FakeTimer to decouple implementations and keep tests extremely fast and non-flaky
- Unit tests should pass in 100ms or less. Do not assume that a failing test can be allowed to fail.

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

```bash
bun run build          # Compile TypeScript
bun run lint           # Lint with auto-fix (run before manual fixes)
bun test               # Run all tests
bun test --bail        # Stop on first failure
bun test <file>        # Run specific test file
```

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

# Codex specific

- GitHub interactions use the GitHub CLI (`gh`).
- Create or edit PRs with `gh pr create`/`gh pr edit` using `--body-file` to preserve newlines.
- Android tasks run via the Gradle wrapper from `android/` (e.g., `(cd android && ./gradlew <task>)`).
- Local validations live under `scripts/` (prefer existing scripts over ad-hoc checks).
- Bun tasks are defined in `package.json` (run with `bun run <script>`).

## Skills

### Foundation Skills
- github-cli: Use `gh` for PRs, issues, checks, and repo metadata. Path: `skills/github-cli/SKILL.md`.
- gh-pr-workflow: Create or update PRs without mangling newlines. Path: `skills/gh-pr-workflow/SKILL.md`.
- android-gradlew: Run Android tasks via `android/gradlew`. Path: `skills/android-gradlew/SKILL.md`.
- bun-tasks: Use `package.json` scripts with Bun. Path: `skills/bun-tasks/SKILL.md`.

### Workflow Skills
- check-ci: Inspect PR checks, fetch failing logs, reproduce likely failures locally, and summarize next steps. Path: `skills/check-ci/SKILL.md`.
- dead-code: Detect and remove dead code using repo scripts and targeted validation. Path: `skills/dead-code/SKILL.md`.
- observe: Inspect the current connected device state through AutoMobile observation tooling. Path: `skills/observe/SKILL.md`.
- test: Run targeted or full test suites with the narrowest relevant command first. Path: `skills/test/SKILL.md`.
- validate: Run repo validation across lint, build, scripts, and platform-specific checks. Path: `skills/validate/SKILL.md`.
- push-pr: Commit, push, create or update a PR, and optionally enable automerge for the current branch. Path: `skills/push-pr/SKILL.md`.
- fan-out-fan-in: Split work into isolated worktrees and merge validated results back. Path: `skills/fan-out-fan-in/SKILL.md`.
- pr-analysis: Perform a deep read-only PR review covering code, tests, CI, and risk. Path: `skills/pr-analysis/SKILL.md`.
- push-my-prs: Iterate over open authored PRs, address feedback, and keep them moving. Path: `skills/push-my-prs/SKILL.md`.
- research: Conduct cited research with saved sources and synthesis summaries. Path: `skills/research/SKILL.md`.
- auto-mobile-code-review: AutoMobile-specific code review of a PR or current diff — verify findings in code, reproduce before asserting, distinguish bugs from daemon-session/env artifacts, reuse repo helpers/conventions, and catch regressions/false-negatives. Path: `skills/auto-mobile-code-review/SKILL.md`.
