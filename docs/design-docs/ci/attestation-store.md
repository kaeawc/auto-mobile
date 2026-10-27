# Attestation store: layout and read cache

Recommendation for #11973 (epic #11972), written so the owner can accept or change it; the issue is
labeled `needs-decision` and stays open until they do. It unblocks the schema in #11979.

Already decided (not reopened here): Neon is the only authoritative store; rows are immutable and
append-only; expiry is a TTL filter or a tombstone applied at read time, never an in-place edit; no
cache on the GitHub side may be the sole basis for a skip, it may only downgrade.

## 1. One table, not one per tier

**Recommendation: a single `attestations` table keyed by content hash, with the tier carried in the envelope.**

| Column                                      | Notes                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `id`                                        | sha256 of the canonical envelope; primary key; makes uploads idempotent |
| `tier`, `input_hash`                        | the lookup key; indexed `(tier, input_hash, produced_at DESC)`          |
| `payload_type`, `payload_version`, `key_id` | routing and audit; copied from the verified envelope                    |
| `envelope`                                  | the signed bytes, exactly as uploaded                                   |
| `produced_at`, `uploaded_at`, `expires_at`  | `expires_at` is the TTL filter                                          |
| `tombstoned_at`, `tombstone_reason`         | set by a separate append-only `tombstones` table, joined at read time   |

Why:

- Every read is "tier T, input hash H". Per-tier tables would give three identical read paths and three
  migration tracks for no query that needs the difference.
- The per-tier payload schemas already differ in the envelope bytes, and the type tag routes
  validation. Columns are not where that variety belongs; a payload field is promoted to a column only
  when a query needs it.
- Tombstones live in their own append-only table, so the attestation rows are never updated.

## 2. No read cache in v1

**Recommendation: no cache for v1. Decide again if a measured trigger below fires.**

A PR makes a handful of lookups (one per gated job, at job start). Neon in the same region as the
service answers a primary-key index lookup in single-digit milliseconds. The cost that can matter is a
scale-to-zero cold start, which a cache does not fix (the first request after idle still pays it); the
answer to that is keeping the compute warm or a pooled connection.

Revisit when either holds over a week of shadow-mode traffic: p95 lookup latency above 250 ms with the
database warm, or lookup volume large enough that Neon connection limits are reached.

If a cache is then needed, it stays inside the trusted boundary and follows these rules:

1. **In-process in the Go service only**, no Redis for now. Anything outside our process boundary is
   the same trust class as the GitHub-side caches we already refuse.
2. **Key** `(tier, input_hash)`. **Only hits are cached**; a miss is never cached, so a fresh upload is
   visible on the next request.
3. **TTL** is at most 60 seconds and never beyond the row's own `expires_at`.
4. **Tombstones and key revocation must not wait for the TTL.** A tombstone write invalidates the
   entry in the writing instance; with more than one instance the 60-second TTL is the only bound, so
   revocation (a producer key revoked) is also checked against the key registry on every read, outside
   the cache. A cached hit is re-checked against `expires_at` and the key registry before it is served.
5. A cache may only lower a decision (skip to advisory or ignore). It is never the sole basis for a skip.

## What this unblocks

The `attestations` and `tombstones` DDL in #11979, with the envelope bytes stored as signed (#11974).
