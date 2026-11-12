# Best-effort keep-booted cleaning

- Kind: decision
- Date: 2026-10-21
- Source: moved from `how-it-works/ios-keep-booted-reset.md`; #14361, #14652
- Shaped: [iOS keep-booted reset](../how-it-works/ios-keep-booted-reset.md)

## Context

Keep-booted reset (#14361, #14652) reuses an iOS simulator without erasing it. The question was how
strong "clean" must be before the broker publishes the simulator idle.

## Options

- Run the supported cleaning operations and a health check.
- Require readback evidence or certify every mutation kind against a baseline.

## Decision

The owner decided to run cleaning operations, not require readback evidence or certify every mutation
kind. There is no before/after baseline diff or all-kinds certification gate.

## Consequences

`outcome: clean` means the supported cleaning operations and health check succeeded, not that all
simulator state matches its baseline. Incomplete or unobservable mutation kinds do not block release.
No contamination-isolation or latency acceptance criterion is claimed; `erase` remains the choice when
a fresh simulator is required.
