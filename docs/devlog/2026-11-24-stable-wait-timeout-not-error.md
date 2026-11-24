# Stable wait timeout is a result, not an error

- Kind: decision
- Date: 2026-11-24
- Source: #19123, #19149, carving out of #16889
- Shaped: [Interaction loop](../how-it-works/mcp/interaction-loop.md)

## Context

Since #16889, every `observe` `waitFor` timeout returns `isError: true` with the last
observation, so a client does not act as if the condition held. A dogfood run (#19123) on an
API 36 emulator found that `observe({waitFor: {for: "stable"}})` timed out as an error on a
screen that was usable: the payload was a complete read of a settled sheet. Action tools also
reported `settled: false` on every launch. The only rows that differed between reads were
status-bar rows: `com.android.systemui:id/mobile_combo` cycling "T-Mobile, one bar." /
"three bars." / "signal full.". Neither result said what was still changing.

## Options

1. Keep every `waitFor` timeout an error, and only add `unsettledBy`.
2. Return a plain `stable` timeout as a normal result with `awaitTimeout: true`, `settled: false`
   and `unsettledBy`, and keep every other timeout an error.
3. Return every `waitFor` timeout as a normal result again.

## Decision

Option 2. A `stable` wait has no condition that can be false: its observation is the screen as
it is, and a timeout means only that the screen kept moving. An element wait's timeout means the
element is not there, so #16889 still applies to it. The carve-out covers only a `stable` wait
that runs out of budget on an awake screen with a readable hierarchy. A screen-off fast-fail,
stale Asleep frames and an unavailable capture stay errors.

With it, the settle comparison now leaves out the SystemUI status bar: root subtrees, the shared
status-bar allowlist and the `mobile_*` / `signal_cluster*` cell-signal rows. A settle or `stable`
wait that ends unsettled reports up to 3 `unsettledBy` entries from the last same-screen diff.

## Consequences

Clients read `awaitTimeout` rather than `isError` to learn that a `stable` wait timed out. Plan
steps and step expectations already fail on `awaitTimeout: true` whether or not the envelope is an
error, so a plan still treats a `stable` timeout as unmet. A new SystemUI status-bar id that
churns between reads needs adding to the status-bar patterns in `src/utils/androidStatusBar.ts`.
