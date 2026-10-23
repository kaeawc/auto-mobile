# Same-daemon session cleanup receipts

`daemon/releaseSession` retains its existing response and timing. Its `success`
and `alreadyReleased` fields are not cleanup completion evidence.

An initialized daemon advertises `daemon/sessionCleanupReceipt` in
`daemon/capabilities`, alongside `daemonGeneration` (the daemon's session UUID).
Capture that generation and the exact acquired session UUID and iOS device UDID
before starting session work. Persist this identity in the caller's own journal.

Send a read-only daemon request:

```json
{
  "id": "receipt-1",
  "type": "daemon_request",
  "method": "daemon/sessionCleanupReceipt",
  "params": {
    "sessionUuid": "00000000-0000-4000-8000-000000000001",
    "deviceId": "00000000-0000-4000-8000-000000000002",
    "daemonGeneration": "the-generation-captured-before-work"
  }
}
```

The normal `{ success: true, result: ... }` envelope means the query worked.
`result` echoes all three requested identity fields and contains `state` and
`reason`. Only `state: "succeeded"` is affirmative cleanup evidence.

| State       | Meaning                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`   | Session is active, release/restoration is running, or pool release has not completed.                                                                             |
| `succeeded` | Release settled, every tracked original cleanup promise fulfilled, no failure or unqualified cleanup was observed, and the captured pool assignment was released. |
| `failed`    | A restoration/cleanup promise rejected, restoration was abandoned, or release failed. Failure remains sticky even if best-effort recovery later succeeds.         |
| `unknown`   | Generation or identity mismatched, history is missing, or this session used a lifecycle path that cannot supply affirmative evidence.                             |

The query never releases a session, refreshes its liveness, starts recovery,
clears a health marker, or admits another session. A successful historical receipt
does not say the device is currently idle: another owner may already hold it.
Queries and repeated legacy release requests do not extend history retention.

## Scope and limits

Affirmative evidence is currently qualified for terminal releases of fresh iOS
sessions, without a rebind, whose device executions were joined before release. The caller must stop
submitting work and join its harness processes, readers, and evidence writers
before requesting release. Provider cleanup does not join caller-owned children.

These cases fail closed:

- Android returns `unknown/platform_not_qualified` unless a failure was observed
  (`failed` wins): its background performance sampler currently signals cancellation
  without joining device commands.
- Recovering or reusing a known session UUID, rebinding it, or retiring/changing
  the device incarnation invalidates affirmative evidence.
- Nonterminal release (including `plan-auto-release`) returns
  `unknown/nonterminal_release`. Such releases permit UUID reuse, which cannot
  safely identify a single operation after bounded receipt history is evicted.
- Sessions that installed a leased iOS app network rule return
  `unknown/network_lease_not_joined`: stopping renewal does not join a renewal
  already in flight.
- An execution still active when release begins returns
  `unknown/executions_not_joined_before_release`, even if it later ends.
- Externally registered cleanup returns `unknown/unverified_external_cleanup`
  even when registered mid-session. Current external hooks include recording,
  location/routes, network state, app links, keyboard/display/kill profiles,
  device conditions, emulator sensors, power, screen lock, status bar, and staged
  downloads, held plan app cleanup (`heldPlanAppCleanup.ts`), and recorder teardown
  redrive. Some internal daemon cleanups (forced-release cap registration,
  network-condition TTL restore, and rebind cleanup) also return
  `unknown/unverified_external_cleanup`.
  Their best-effort promises may swallow failures or use bounded joins.
  A rejected promise observed before completion is `failed`; fulfillment alone
  cannot verify these contracts.
- Cleanup health marks without an originating session are attributed to the
  device's current owner, whether active or releasing. This fails closed: the
  receipt may read `failed` or `unknown`, never `succeeded` for that cleanup.
- Failed or missing pool release never becomes success merely because the
  session disappeared or a cleanup promise settled.

Completed receipts are immutable. At most 256 completed records are retained in
completion order; queries do not refresh that order. An `unknown` answer enters
completed history as soon as release settles, regardless of pending work or pool
confirmation. Failed receipts with original work pending normally remain visible.
There is also a hard cap of 1024 uncompleted, release-settled records: exceeding it
evicts the oldest such record, including wedged or failed work. Active sessions
and releases that have not settled are excluded from that cap. Eviction returns
`unknown/no_matching_history`.

A per-generation FIFO set remembers the last 4096 distinct bound session UUIDs.
Rebinding a remembered UUID returns `unknown/recovered_or_reused_session` even
after its receipt was evicted. Once that tombstone is evicted, reuse cannot be
detected; callers must continue minting fresh UUIDs. Nothing is persisted. Changing
the daemon generation clears receipt history and tombstones; a new generation
cannot attest to cleanup owned by its predecessor.

Broker `releaseStatus` (`released` / `cleanup_pending`) attests to resource state.
`BrokerExecutionReleaseResult.settlement` (`confirmed` / `settling`) reports
whether execution release has settled. Neither reports restoration failure.
Broker managed executions release through `releaseSessionAndDevice`, so they get
cleanup receipts too. Receipts add no reset or teardown work and do not change
when the pool makes a device reusable.

Current reasons are:

- `pending`: `session_active`, `teardown_in_progress`, `pool_release_incomplete`.
- `succeeded`: `cleanup_completed`.
- `failed`: `cleanup_rejected`, `release_failed`, `release_callback_failed`,
  `release_forced`, `pool_release_failed`, `restoration_failed:keep_awake`, and
  `restoration_abandoned:<kind>` where kind is `keep-screen-awake`,
  `biometric-enrollment`, `network-condition`, `screen-reader`, `rotation`,
  `app-cleanup`, or `recording-teardown`.
- `unknown`: `daemon_generation_mismatch`, `no_matching_history`,
  `receipts_unavailable`, `recovered_or_reused_session`, `platform_not_qualified`,
  `session_rebound`, `nonterminal_release`, `network_lease_not_joined`,
  `executions_not_joined_before_release`, `unverified_external_cleanup`,
  `release_not_committed`, `pool_ownership_changed`, `device_identity_replaced`,
  `device_removed`, `device_incarnation_changed`, or `release_forced` when the
  forced-before-start path invalidates evidence (an observed forced failure wins).

Reasons are diagnostic. Only the generic `cleanup_rejected` failure may be
refined to a named lifecycle reason before completion; failure remains sticky.

## Caller integration

1. Require the capability and persist the generation, fresh session UUID, and
   exact UDID with the local operation before mutation.
2. Keep local admission occupied through execution, child joining, release,
   receipt lookup, and evidence persistence.
3. After a release timeout, cancellation, or lost reply, query the original
   identity on the same daemon. Poll `pending` within the caller's bound.
4. Commit local completion only for an exact matching `succeeded` result.
   Keep durable ownership and block admission on `failed`, `unknown`, timeout,
   malformed replies, or a generation change. Do not adopt the new generation
   to reinterpret an old operation.

General restart recovery and a recovery transition for a blocked local journal
are separate work. This protocol adds no durable provider recovery or admission
bypass.
