# AutoMobile

Node TypeScript MCP server providing Android Debug Bridge (ADB) capabilities through MCP tool calls for device automation.

## Key Rules
- TypeScript only (no JavaScript)
- After implementation changes, run relevant validation commands
- Write terminal output to `scratch/` when not visible
- Local validation scripts live under `scripts/` and should almost always be written in bash with shellcheck validation
- Always use interfaces & fakes & FakeTimer to decouple implementations and keep tests extremely fast and non-flaky
- Unit tests should pass in 100ms or less. Do not assume that a failing test can be allowed to fail.
- One canonical primitive per concern: UUIDs come from `IdGenerator`, randomness from `Random` (`pick`/`next`), backoff from `Backoff`. Inject these (interface + fake) rather than spawning a new `randomUUID()`/`Math.random()` path.
- Prefer narrow interfaces that expose exactly what consumers need (YAGNI); grow the interface when the second consumer arrives, not ahead of need.

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
