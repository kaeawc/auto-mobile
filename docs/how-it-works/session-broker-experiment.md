# Session-only provider experiment

A caller requests a device, receives a fresh execution session UUID, uses it, and
releases it. Callers never select slots, pool identities, runner scopes, or
capacity. Requirement vocabulary and default resolution:
[session-requirements.md](session-requirements.md). Reuse/reset/capacity tuning:
[Session broker device reuse, reset, and capacity](session-broker-device-reuse.md).

The experiment is opt-in: set `AUTOMOBILE_SESSION_BROKER_CONFIG` to the absolute
path of an operator JSON configuration when starting the provider daemon. An
already-running ordinary daemon does not become a broker because a client
requests the new contract.

Reset and operations detail are on these pages:

- [Android keep-booted and snapshot reset](session-broker-experiment-reset.md)
- [Operator configuration, consumer contract, native identity and recovery](session-broker-experiment-operations.md)

## Timing receipts and statistics

`contractVersion: 1` replies gain an optional `timing` object (consumers ignore
unknown fields; `session-request-status --json` preserves it unprojected).
The broker stores `timing.acquisition` on the request receipt; release replies include it
plus `timing.reset`. The broker updates a `cleanup_pending` reply's reset record after
cleanup, so read request status for the final record. Legacy receipts,
pre-admission refusals, and a `cleanup_pending` reply whose budget expired before
timing existed may omit timing.

**Acquisition record**: `admission` (`reuse`, `create`, `evict-then-create`,
`wait`; `wait` only on failed/pending records), `outcome` (`pending`, `ready`,
`failed`), `reuseCount`, `startedAtMs` and optional `completedAtMs`. Its phases are
`queueMs` (always 0: no admission queue), `admissionWaitMs` (catalog/default
resolution plus the reservation transaction), `createMs` (includes exact-device
discovery/provisioning), `bootMs`, `automationReadyMs` and `totalMs`. Native phases
come from the provision timing tree (`provisionExactDevice`, `bootDevice`);
unmeasured phases are omitted, never zero. Reuse reports zero create/boot.
`reuseCount` starts at 0 and increments once per reuse reservation, even if
preparation later fails.

**Reset record**: `mode` (`keep-booted`, `erase`, `snapshot`, `wipe-data`,
`none`), `outcome` (`clean`, `fallback:<mode>`, `destroyed`, `pending`), `phases`
(name to ms), optional `fallbackReason`, `reuseCount`, timestamps, `totalMs`.
The broker phases are `drain` and `reset`. Platform resetters add native phases (iOS
erase: `stop`, `erase`, `boot`, with partial evidence on failure). The
`ResetOutcome` port record is `{ outcome, mode, phases, fallbackReason? }`; legacy
`"clean"`/`"pending"` returns stay accepted (unknown mode is `none`).
A `fallback:<mode>` outcome means a clean fallback completed and is reuse-eligible, not just
attempted; `none` is not a fallback mode. Failed resets keep the reason and end as
`destroyed` after authoritative cleanup.

**`daemon/sessionBrokerStats { windowMs?, limit? }`** (read-only): window default
24 h / max 30 d; sample cap default 5000 / max 10000. Returns `sinceMs`, `untilMs`,
`limit`, `truncated`, and `groups` per exact platform/profile with
acquisition/reset counts, `reuseHitRate`, `fallbackRate`, `retirements`, and
per-phase `{ count, p50, p90 }` ms (linear-interpolation percentiles; rates are
fractions, empty denominators give 0).

Only completed records in the window count;
acquisition counts, percentiles and hit rates use only `ready` acquisitions;
the stats skip unknown phases. It reads the newest updated receipts up to the cap and
reports truncation: these are sampled receipts, not lifetime counters.
The `retirements` value counts destroyed reset records plus idle-trim retirements marked
`retired` (including destruction still pending), not admission evictions or
failed-acquisition destruction. Timing and the saved profile survive provider
restart; the broker prunes them with receipts under `RECEIPT_RETENTION_MS` (export pins
retain their behavior). Structured log lines carry the same records and profile
without owner tokens, scope keys or allocation indices.

## Pinned session exports

Broker mode advertises `session-broker-export/v1`. A client may pass strict
`export: { prepareId, requestDigest }` (1-256 chars each) to
`daemon/prepareSession`. Admission and pre-admission failures link the identity to
the request receipt in the same transaction, before native work. Replays may link
a previously unexported receipt; conflicting identities/digests fail with
`session_export_identity_mismatch`.

- `daemon/getSessionExport { prepareId, requestDigest, livenessOwnerToken }`
  returns `{ contractVersion: 1, prepareId, requestDigest, acknowledged, result }`
  or `session_export_not_found`. The result derives from the current durable
  receipt (after owner-exit recovery: `failed` / `session_owner_exited` with the
  original session UUID and profile). Auth uses the original consumer token even if
  recovery changed the daemon owner. Reading grants no session control and never
  acquires a replacement.
- `daemon/acknowledgeSessionExport` (same params) returns
  `{ prepareId, outcome: "acknowledged" | "unknown_export" }`. Digest and owner
  checks precede acknowledgement; exact replays keep the first acknowledgement time.
- An unacknowledged export pins its receipt past the 30-day terminal window, up to
  a configurable 180-day export age. Acknowledged/expired rows prune with their
  eligible receipts (pending resource cleanup and tombstone guards still apply).
  Clients omitting `export` keep the existing prepare contract.

## Shutdown refusals and retry cadence

Once restart handoff begins, new prepare and abandon calls return an RPC refusal:
`success: false`, `code: "session_broker_stopping"`, `retryable: true`,
`retryAfterMs: 5000`. Retry the same identity against the successor daemon; the
refusal neither admits a request nor stores a receipt. Already-admitted
preparations interrupted by shutdown store a terminal `session_broker_stopping`
receipt with `retryable: true`, `retryAfterMs: 5000`,
`retryRequires: "new_request_id"` (even while cleanup is pending); first reply and
replays carry identical guidance.

Operator `daemon/cleanupBrokerAvdSnapshots` maintenance
refuses new prepare calls with `session_broker_maintenance` and the same retry hints,
without storing a receipt. Its fence waits for all admitted preparations to settle
before AVD discovery or snapshot deletion, and releases even when cleanup fails.
It deletes snapshot directories, `default_boot` included, only for a broker-named AVD
that no registry assignment or journal entry references and that has no live process
or serial. It always keeps the `automobile-broker-baseline-*` snapshot and never
touches user AVDs or whole AVD directories. A cleaned orphan cold-boots if relaunched.
Pool drain and idle expiry remain outside this fence.

`session_restart_handoff_pending` and configured-but-unavailable refusals use the
same hint, matching the service's five-second recovery interval. It is a pacing
hint, not a readiness deadline. Stopping/handoff-pending refusals log at debug;
non-retryable owner and export identity mismatches warn. A failed initial handoff
snapshot warns and still joins preparations; close retries the snapshot after the
join. A failed second snapshot rejects close so the service keeps its host lock.

A liveness owner token that does not own a request gets non-retryable
`session_request_owner_mismatch` from status, release and abandon, with
`details: { terminal }` and nothing else. Ownership protects binding and release, so
a non-owner learns only whether the request is finished. The `terminal` flag is true when the
request is released, or failed with no device cleanup (durable resource cleanup or an
abandoned preparation still unwinding) in progress. A host restarted under a new token
can drop a journal whose refusal is terminal; a non-terminal one is still live.

## Reuse and reset boundary

Default is zero pooling: every relinquished device is destroyed through the
durable native journal, with authoritative absence required before capacity is
freed.

- **iOS**: clean reuse is an experimental opt-in (`reuseCleanDevices`, iOS only).
  Reset drains the execution, stops via the ordinary lifecycle handler, erases, and
  boots the same simulator. Fresh inventory must confirm exact type, runtime,
  availability and expected state; durable ownership and native-binding checks
  fence every mutation. Any failure falls back to journaled destruction.
- **Android**: separate `reuseAndroidCleanDevices` (default false). With Android
  defaults, `androidResetMode` is `keep-booted` (best-effort cleaning) or
  `snapshot` (baseline restoration).
- Without a mutation-aware strategy, any package-list difference requires
  destruction, never uninstall-and-pool. Baseline capture failure warns without
  failing acquisition; release then destroys. Baselines and activity subscriptions
  are scoped to the broker resource, not its recyclable adb serial.
- The native activity guard is conservative: the execution-end event does not
  identify the tool, so any admitted non-read session use (including package
  install) disables minimal reset. Read-only sessions cannot reuse either, since adb
  and Gradle activity are unobservable. The `AndroidResetStrategy` port stays injectable
  (#14364, #14365) with optional fenced capture and retirement hooks. Strategies
  fence native work via `assertOwned`. Target/boot/package-manager/CtrlProxy checks
  are safeguards, not isolation proof, and fake-strategy tests are not evidence of
  native isolation.

## Background

- [Session broker native qualification](../devlog/2026-10-23-session-broker-experiment-native-qualification.md)
- [Keep-booted reset is operational cleanup](../devlog/2026-10-21-session-broker-experiment-keep-booted-cleanup.md)
