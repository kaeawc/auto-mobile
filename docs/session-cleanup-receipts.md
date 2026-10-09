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

- Android returns `unknown/platform_not_qualified`: its background performance
  sampler currently signals cancellation without joining device commands.
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
  when it fulfills. Current recording, network-mock, and location hooks expose
  best-effort promises, including swallowed failures and bounded joins. A
  rejected promise is `failed`. The receipt does not reinterpret those contracts.
- Failed or missing pool release never becomes success merely because the
  session disappeared or a cleanup promise settled.

All in-flight records are retained, including failed records with original
device work still pending after a teardown timeout. At most 256 completed
records are retained, in completion order. Eviction returns `unknown`; reads do
not refresh that order. Nothing is persisted by this facility. A new daemon
generation cannot attest to cleanup owned by its predecessor.

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
