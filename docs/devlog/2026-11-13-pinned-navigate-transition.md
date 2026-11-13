# Pin a `navigateTo` attempt to one transition

- Kind: decision
- Date: 2026-11-13
- Source: #16982 (follow-up to #16953 and PR #16981)
- Shaped: [Navigation graph](../using/navigation-graph.md)

## Context

The desktop transition-detail navigate action called `navigateTo(targetScreen)`. The daemon
plans its own path, so when the device was not on the transition's source, or when parallel
edges join the same two screens, a reached attempt did not prove the selected edge.

## Options

- An edge-pinned `navigateTo`, as the issue proposes: by edge id, or by from, to and trigger.
- Not recorded beyond that.

## Decision

`navigateTo` takes an optional `viaTransition` (`from`, `to`, and optionally `edgeId` or
`toolName`). It identifies a transition the way `getNavigationGraph` lists one, `from` → `to`
via `toolName`; an `edgeId` resolves to that listed transition's tool. The call reaches `from`
by any known path, then replays one recorded edge of that transition with no fallback edge. A
missing transition, a failed lead-in, or a replay that does not land on `to` is reported as not
reached with the current screen. The desktop navigator sends the transition's screens and, when
its id is numeric, its edge id.

## Consequences

Unpinned `navigateTo` is unchanged. A successful pinned attempt always traversed the selected
transition, so a speculative desktop attempt that succeeds verifies that transition once the
daemon records it.
