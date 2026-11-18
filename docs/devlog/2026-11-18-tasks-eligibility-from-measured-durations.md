# Tasks eligibility from measured tool durations

- Kind: decision
- Date: 2026-11-18
- Source: #13944
- Shaped: [MCP SDK v2: tasks and skills extensions](../how-it-works/mcp/sdk-v2-extensions.md)

## Context

The Tasks rule is that a call returning in under about 2 s should not become a task. #13944
measured tool durations from host telemetry (10,024 calls, no per-action split) and a short
Android emulator run. Tools over 2 s: `explore` (p50 16.3 s), `setUIState` (p50 11.0 s, already
eligible since #18531), `killDevice` (wall p50 5.9 s), `deviceSnapshot` (telemetry p50 2.1 s,
p95 9.4 s; capture p95 2.9 s on a clean device), and interactive tools with a p50 of 3 to 5 s
(`tapOn`, `pressButton`, `sendKeys`, `swipeOn`, `launchApp`). `installApp`, `uninstallApp` and
`putAppFile` (150 MB) stayed under 2 s.

## Options

- Make every tool over 2 s eligible, including the interactive ones.
- Make only the long, non-interactive tools eligible, each with a cancel policy that matches how
  it handles an abort.
- Make `launchApp` eligible only with `coldBoot` or `clearAppData`.

## Decision

`explore` and `killDevice` are eligible with `abort`: explore checks its signal between
interactions, and killDevice already recovers from an aborted shutdown. `deviceSnapshot` capture
and restore are eligible with `detach`: neither takes a signal, and stopping one partway would
leave a partial snapshot or a half-restored device. Snapshot delete stays synchronous.
Interactive tools stay synchronous, because a task round trip costs more than it saves.
`launchApp` stays synchronous: telemetry has no arguments, so the cost of `coldBoot` and
`clearAppData` calls is not measured.

## Consequences

`TASK_ELIGIBILITY` in `src/server/tasks/toolCallTasks.ts` names these tools. Making `launchApp`
eligible needs a measurement split by its arguments first. iOS durations were not measured.
