# Stateless success reductions in the response envelope

- Kind: decision
- Date: 2026-11-15
- Source: #18348 (regressions of #11636 and #17464 item 3, fixed by #17480)
- Shaped: [Interaction loop](../how-it-works/mcp/interaction-loop.md)

## Context

The 0.0.94 dogfood run saw two earlier fixes fail. The `getAndroid` success
response had a `timing` tree of about 200 entries again, and every `tapOn`
returned `element` next to an identical `selectedElement.matchedElement`. Neither
fix had been reverted. Each one was gated on state outside the response:

- `timing` was attached only while `debug-perf` is on. `debug-perf` is a persisted
  feature flag, so one earlier `--debug-perf` run or `AUTOMOBILE_DEBUG_PERF=1`
  turned it back on for every later daemon.
- The duplicate `element` was removed inside the action-metadata compaction. That
  runs only with `actions-compact-metadata` on and a session baseline store, and
  tests pinned that turning compaction off brought the duplicate back.

The same run saw a no-op `tapOn` (`skipped: "already-checked"`) return an empty
diff that still restated all skeleton and context rows.

## Options

Not recorded.

## Decision

Both removals moved to one envelope step for agent-facing successes. It needs no
session, store or output flag. Internal calls and failures keep both fields. An
action diff with no change carries `unchanged: true` instead of the skeleton. It
does so only when the unprojected diff is empty too, because the projection drops
non-actionable added rows that `context` would show.

## Consequences

`debug-perf` no longer puts the acquisition `timing` tree on the wire. The
handler still builds it for in-process callers. A client reading a diff must
accept a missing `skeleton` when `unchanged` is true. Item 4 (bounds-only
`changed` rows) and item 5 (`getAndroid` with no device argument) of #18348 are
not covered.
