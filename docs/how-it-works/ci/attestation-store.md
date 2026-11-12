# Attestation store: layout and read cache

The proposed store layout for CI attestations (#11973, epic #11972). It is the input to the schema in
#11979; #11973 stays open (`needs-decision`) until the owner accepts or changes it.

Fixed constraints: Neon is the only authoritative store; rows are immutable and append-only; expiry
is a TTL filter or a tombstone applied at read time, never an in-place edit; no GitHub-side cache may
be the sole basis for a skip, it may only downgrade.

## 1. One table, not one per tier

A single `attestations` table keyed by content hash, with the tier carried in the envelope.

| Column                                      | Notes                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `id`                                        | sha256 of the canonical envelope; primary key; makes uploads idempotent |
| `tier`, `input_hash`                        | the lookup key; indexed `(tier, input_hash, produced_at DESC)`          |
| `payload_type`, `payload_version`, `key_id` | routing and audit; copied from the verified envelope                    |
| `envelope`                                  | the signed bytes, exactly as uploaded                                   |
| `produced_at`, `uploaded_at`, `expires_at`  | `expires_at` is the TTL filter                                          |
| `tombstoned_at`, `tombstone_reason`         | set by a separate append-only `tombstones` table, joined at read time   |

A payload field becomes a column only when a query needs it. Tombstones live in their own append-only
table, so attestation rows are never updated.

## 2. No read cache in v1

Revisit when either holds over a week of shadow-mode traffic: p95 lookup latency above 250 ms with the
database warm, or lookup volume large enough to reach Neon connection limits.

A cache added then must follow these rules:

1. **In-process in the Go service only**, no Redis.
2. **Key** `(tier, input_hash)`. **Only hits are cached**; a miss is never cached, so a fresh upload is
   visible on the next request.
3. **TTL** is at most 60 seconds and never beyond the row's own `expires_at`.
4. **Tombstones and key revocation must not wait for the TTL.** A tombstone write invalidates the
   entry in the writing instance; with more than one instance the 60-second TTL is the only bound, so
   key revocation is checked against the key registry on every read, outside the cache. A cached hit
   is re-checked against `expires_at` and the key registry before it is served.
5. A cache may only lower a decision (skip to advisory or ignore). It is never the sole basis for a skip.

## What this unblocks

The `attestations` and `tombstones` DDL in #11979, with the envelope bytes stored as signed (#11974).

## Background

- [Attestation store layout and read cache](../../devlog/2026-10-27-attestation-store-layout.md)
