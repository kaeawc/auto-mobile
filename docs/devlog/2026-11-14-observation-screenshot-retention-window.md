# Observation screenshots stay readable for a bounded window

- Kind: decision
- Date: 2026-11-14
- Source: #18337
- Shaped: [observe](../using/observe.md)

## Context

The observation screenshot resource only served an observation while it was the device's
current cached one. A harness that records evidence after the agent's next step lost the
screenshot with `OBSERVATION_NOT_RETAINED`: the next observation replaced it, or an action that
may change the foreground app cleared the device cache first.

## Options

1. Keep the last few observations per device and serve each one by id until the count or the
   TTL evicts it.
2. Add an explicit pin or lease that a caller takes and releases, with a hard upper bound.

## Decision

Option 1. The screenshot state store already kept the last 10 observation captures per device
for the 5-minute cache TTL, so the resource now checks that store instead of the current
observation. A foreground-changing action's cache invalidation keeps completed captures, which are
immutable; session end, device release and other full clears still drop them. The store
remembers why an observation left the window, and the error reports it as `evictedBecause`
(`newer-observation`, `ttl` or `cache-cleared`) with `supersededBy` when a newer observation
pushed it out. No pin or lease was added.

## Consequences

A caller has up to 10 newer observations or 5 minutes, whichever comes first, to read a
screenshot by id. The retention window and its error fields are documented in the user page.
