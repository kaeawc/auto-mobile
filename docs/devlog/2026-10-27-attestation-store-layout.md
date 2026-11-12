# Attestation store layout and read cache

- Kind: decision
- Date: 2026-10-27
- Source: moved from `how-it-works/ci/attestation-store.md`; #11972, #11973, #11979, #15554
- Shaped: [Attestation store: layout and read cache](../how-it-works/ci/attestation-store.md)

> [!NOTE]
> This is a recommendation. #11973 is labeled `needs-decision` and stays open until the owner accepts or
> changes it.

## Context

The decision service (#11979) needs a schema for attestations in Neon. Already decided: Neon is the
only authoritative store, rows are append-only, expiry is applied at read time, and no GitHub-side
cache may be the sole basis for a skip.

## Options

- One `attestations` table for every tier, or one table per tier.
- A read cache in v1, or none.

## Decision

**One table.** Every read is "tier T, input hash H". Per-tier tables would give three identical read
paths and three migration tracks for no query that needs the difference. The per-tier payload schemas
already differ in the envelope bytes, and the type tag routes validation; columns are not where that
variety belongs.

**No cache in v1.** A PR makes a handful of lookups (one per gated job, at job start). Neon in the same
region as the service answers a primary-key index lookup in single-digit milliseconds. The cost that
can matter is a scale-to-zero cold start, which a cache does not fix (the first request after idle
still pays it); the answer to that is keeping the compute warm or a pooled connection. If a cache is
needed later it stays in-process in the Go service: anything outside the process boundary is the same
trust class as the GitHub-side caches already refused.

## Consequences

The page records the layout, the revisit triggers (p95 above 250 ms warm, or Neon connection limits)
and the rules any later cache must follow.
