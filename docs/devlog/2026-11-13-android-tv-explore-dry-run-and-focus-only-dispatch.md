# Android TV explore: dry-run input mode and focus-only dispatch

- Kind: decision
- Date: 2026-11-13
- Source: #17233 (follow-ups from the #17186 review), options listed in #17237
- Shaped: [Android TV](../using/android-tv.md)

## Context

On a TV, `explore` acts by D-pad focus and select, but `explore { dryRun: true }` planned `tapOn`
and `swipeOn` steps with nothing saying a run would execute them differently. Separately,
`focusNavigate` reports its dispatch only before the select press, and the navigation history keeps
the first dispatch report on purpose (#10196). A call with `select: false` is therefore timed from
its start, and a focus-only walk that changes the screen more than 2 seconds later goes
uncorrelated.

## Options

Dry run (#17237, B):

1. Keep touch plans and document that a TV runs them by D-pad.
2. Emit D-pad steps (`focusNavigate`, a list advance) in `plannedInteractions`, a new action
   vocabulary in the output schema.
3. Add a plan-level `inputMode: "touch" | "dpad"` and keep the per-step actions.

Focus-only dispatch (#17237, A):

1. Keep the first-report rule and document that long focus-only transitions are not recorded.
2. An opt-in "latest dispatch" report for focus walks, replacing an earlier report until an event
   correlates; this extends the shared dispatch contract.
3. Widen the correlation window by the walk's duration, which can claim an unrelated navigation.
4. Stop recording focus-only calls, which also drops short focus-triggered transitions.

## Decision

Dry run: option 3. The result carries `inputMode`, resolved by the same device-traits read a run
uses, so a caller knows a TV run moves focus and selects instead of tapping. The step vocabulary
is unchanged.

Focus-only dispatch: option 1. `explore` itself always records `focusNavigate` with
`select: true`, so its edges are timed from the select press; only caller-issued focus-only walks
are affected, and no device run so far has shown a TV app whose navigation needs a long one.
The #10196 ordering stays untouched.

## Consequences

- `exploreResultSchema` gains an optional `inputMode`, and every dry-run result sets it.
- The Android TV page states the 2-second limit for `select: false`. If a real TV app needs long
  focus-triggered transitions recorded, revisit option 2 with tests for the #10196 ordering.
