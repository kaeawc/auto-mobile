# Interaction loop: default compact action metadata

Part of [Interaction loop](interaction-loop.md).

## Default compact action metadata

Compact action metadata defaults on. Opt out with
`AUTOMOBILE_ACTIONS_COMPACT_METADATA=0`, `--no-actions-compact-metadata`, or
feature-flag key `actions-compact-metadata` set to false. The existing
`--actions-compact-metadata` or exact env `1` explicitly enables it. Negative CLI
wins over positive CLI, then exact env `0`/`1`, then persisted state, then on.
An explicit CLI/env choice is connection-scoped: the proxy relays it on its
connection profile, never restarts the shared daemon for it, and never persists it.
Without an explicit choice (unset or other env values), proxies relay no preference
and use the shared daemon's effective setting.

With an external action call's `sessionUuid` and session store,
compaction omits each unchanged `observation` block independently: `insets`,
`systemInsets`, `backStack`, `gfxMetrics`, `displayedTimeMetrics`, `deviceLock`, `deviceLockUnknown`,
`accessibilityState`, and `freshness`. Raw observations' `viewHierarchy.insets`
and `viewHierarchy.systemInsets` copies follow the same rule independently.
Together, `deviceLock` and `deviceLockUnknown` form one mutually exclusive block:
a delivered variant replaces the sibling in the server snapshot and the client's state.
A variant transition always sends the new field in full; omission of both means
unchanged. Values must be deeply equal except `backStack.capturedAt`. Stale
freshness (`isFresh !== true`), unstable gfx metrics (`isStable === false`) and
partial back stacks remain inline even if unchanged.
The first action response, a new session and any device switch send available
blocks in full; a change resends the changed block. The `screenSize`, `display`,
and observation/device join keys remain present.

Compaction follows projection and diff emission. With `--actions-diff-observe`,
only metadata the diff emits can be compacted (including its
`freshness` passthrough); the hierarchy diff baseline is unchanged. With
`--actions-no-observe`, there are no observation blocks to compact or remember.
An empty snapshot on a device switch invalidates the previous device's metadata
without claiming delivery.

Two reductions apply to every agent-facing success, whatever the compaction
setting and with or without a session. A top-level `element` is omitted when it
names the same node as `selectedElement.matchedElement` (same identity attributes
and bounds, an empty label counting as absent) and its output schema allows
omission. A `getAndroid`, `getApple` or `startDevice` success never carries the
per-command `timing` tree, even with `debug-perf` on; `readiness.elapsedMs` carries
the total. Internal calls and failures keep both fields.

The record of sent blocks holds only blocks that survive artifact and
oversized-residue spills **inline**. Artifacts always come from the uncompacted
payload; an artifact pointer does not count as delivery. Any non-internal
session-scoped response that carries a block inline (including `observe` and
error responses, which never omit blocks themselves) updates the record for
exactly those blocks. Internal
tool-to-tool calls neither omit nor record, and calls without a session/store
emit the full response. The record lives in the session cache, and
session release/rebind clears it. The server writes it while finalizing the
response, before the transport sends it. A response dropped after that point
leaves the client without the omitted block until it changes.
