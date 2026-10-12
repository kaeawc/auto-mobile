# Session-only provider experiment

This local experiment adds a provider contract in which a caller requests a
device, receives a fresh execution session UUID, uses that session, and releases
it. Callers do not select slots, pool identities, runner scopes, or capacity.
The requirement vocabulary and default resolution are documented in
[session-requirements.md](session-requirements.md).

## Current qualification boundary

The first native milestone deliberately uses zero pooling. Every relinquished
device is destroyed through the existing durable native journal, with
authoritative absence required before its capacity is freed. The broker has
tested clean-reset and reuse interfaces, but native reuse is rejected until
platform contamination tests qualify an implementation. Fake reset tests are
not evidence of native isolation.

The experiment is opt-in. Set `AUTOMOBILE_SESSION_BROKER_CONFIG` to the absolute
path of an operator JSON configuration when starting the provider daemon.
An already-running ordinary daemon does not become a broker because a client
requests the new contract.

Example operator configuration for a host with the corresponding installed
CoreSimulator device type and runtime:

```json
{
  "contractVersion": 1,
  "limits": {
    "totalDeviceCap": 2,
    "sessionCap": 2,
    "idlePoolCap": 0
  },
  "defaults": {
    "ios": {
      "platform": "ios",
      "policyVersion": "local-ios-26.5-v1",
      "hardware": {
        "omitted": "phone",
        "archetypes": [
          {
            "archetype": "phone",
            "modelType": { "family": "iphone", "variant": "pro" }
          }
        ],
        "modelTypes": [
          {
            "modelType": { "family": "iphone", "variant": "pro" },
            "model": { "namespace": "product-model", "value": "iPhone18,1" }
          }
        ]
      },
      "os": {
        "selector": { "kind": "exact", "version": "26.5" },
        "preferredVersion": "26.5"
      }
    }
  },
  "reuseCleanDevices": false
}
```

Caps are optional, nonnegative integers. Reservations, native creation, active
sessions, reset, uncertain state, and unfinished destruction count toward the
total cap. Failed acquisition with unfinished native work retains session
capacity too. A full pool must confirm eviction before reserving a replacement;
there is no temporary burst. Pool selection prefers the most recently returned
compatible device and evicts the least recently returned idle device.

## Consumer contract

Start the normal MCP proxy with `--session-config <json-or-path>` or
`AUTOMOBILE_SESSION_CONFIG`. It is mutually exclusive with managed-slot
configuration, a preselected session UUID, and direct/no-proxy mode.

```json
{
  "contractVersion": 1,
  "requestId": "a-new-unique-id-for-this-execution-attempt",
  "device": {
    "schemaVersion": 1,
    "platform": "ios",
    "hardware": { "kind": "archetype", "archetype": "phone" },
    "os": { "kind": "omitted" }
  },
  "idleTimeoutMs": 3600000
}
```

The proxy probes `session-broker/v1`, prepares the request, and publishes its
flat result under MCP initialize capability
`experimental["automobile/session"]`. No resource API is added. A ready result
contains the granted session UUID and resolved device profile. Pending or failed
preparation exposes no device tools and never falls back to generic acquisition.
The existing keeper maintains liveness; EOF and execution-owner exit cancel
preparation or relinquish the granted session.

The daemon protocol is:

- `daemon/prepareSession`: `{config, livenessOwnerToken}`.
- `daemon/sessionRequestStatus`: `{requestId, livenessOwnerToken}`.
- `daemon/releaseBrokerSession`: `{sessionId, livenessOwnerToken}`.
- Reconnect registration: `{sessionId, clientName, sessionBroker:
  {requestId, livenessOwnerToken}}`.

The token and complete request configuration define operation identity.
After an ambiguous reply, query the same identity. Replaying an admitted
request returns its durable receipt, including a terminal receipt; it never
allocates a replacement session. A new execution attempt needs a new request ID.
Release reports either confirmed release or cleanup still pending. A later
recovery pass owns pending cleanup independently of the client connection.

## Ownership and recovery

There is one host registry and one native journal authority. The broker adds
durable request receipts and admission reservations to that same SQLite
database, using its immediate transactions for cross-process admission. Existing
assignment generations and native journal operations remain private implementation
details. Allocation indices are not recycled as public session identities.
This changes provider-local SQLite only; it requires no Talos PostgreSQL change.

Broker mode holds a process-generation-aware host lock and refuses startup over
unaccounted managed inventory or live generic sessions. Drain the prior provider
before opting in. It disables legacy allocation/reset requests and competing
abandoned-scope/free-pool reclaimers. Native journal recovery starts only after
the ownership checks. Generic or nested tool calls cannot acquire a device or
operate without a live broker-granted session.

Interrupted requests retain durable cleanup ownership. Recovery never promotes
an interrupted device to a clean pool entry, and failure of one request does not
starve later cleanup. Shutdown cancels and joins broker work before closing its
registry; recovery-loop waits are interruptible. A forcibly terminated process
can leave native work pending, so restart qualification must exercise the durable
journal rather than assume graceful shutdown always completes.

Application installation and initial configuration are deterministic operations
on the granted session, before the model starts. They do not require a Slack
application SDK. Combining them into the acquisition request remains a later
ergonomic change; the lifecycle boundary already encloses the entire execution.
