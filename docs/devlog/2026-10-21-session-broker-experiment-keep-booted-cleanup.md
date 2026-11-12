# Keep-booted reset is operational cleanup

- Kind: decision
- Date: 2026-10-21
- Source: moved from `how-it-works/session-broker-experiment.md`; #14358, #14364, #14667
- Shaped: [Session-only provider experiment](../how-it-works/session-broker-experiment.md)

## Context

Android keep-booted reset cleans a device between broker sessions instead of restoring a snapshot
or destroying it. The question was whether a clean must be proven by readback against the
captured baseline.

## Options

Not recorded.

## Decision

Owner decision (#14358 / #14364): "i actually don't care about readback and having evidence, i just
want to run whatever cleaning operations". Keep-booted is operational cleanup; no baseline diff or
post-clean certification is required, and certification metadata never blocks it.

## Consequences

Residual state is accepted when commands and health checks succeed; keep-booted is not equivalent
to snapshot or wipe-data isolation.
