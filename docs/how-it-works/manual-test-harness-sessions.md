# Manual-test harness: devices and sessions

Part of [the manual-test harness](manual-test-harness.md).

## Devices and teardown

`devices --batch-dir "$B" [--daemon K] [--timeout-ms 30000]` lists only running
devices with a nonempty runtime device ID and lifecycle `booting`, `booted` or
`shutting-down`. JSON: `batchDir`, `protectedDevices`, baseline availability, daemon
liveness/errors, and device rows. Each row has `deviceId`, `name`, `identity.stableId`,
`platform`, `isVirtual`, `seenByDaemons` (visibility, not boot ownership), `pid` (+ optional
`pidReason`; null for iOS and physical), `provenance`, `protected`, `poolStatus`, and
`heldBy` when exposed. Rows also carry optional `bootedBy: "daemon<N>"` (from `MT_DAEMON`)
and `processAvdName` (the process's `-avd` argument).

Positive evidence is the `MT_BATCH`/`MT_DAEMON` environment an emulator inherits
from its private daemon. The harness reads it with `ps eww -o command= -p <pid>` for the
one Android console-port listener PID `lsof` resolved (5000 ms per probe). This has not
yet been observed on a live batch. A missing PID, failed/empty read, or any iOS simulator has
no process evidence. Provenance:

- `batch-booted`: the process carries exactly this batch's `MT_BATCH` marker.
- `foreign`: environment read without this batch's marker, regardless of baseline.
- `preexisting`: no process evidence; runtime ID is in the first-start baseline
  (`shared/host-devices-at-start.json`).
- `batch-inferred`: no process evidence; ID absent from a recorded baseline for its platform.
- `unknown`: no process evidence and the platform baseline is missing, or two daemon rows conflict.

Baseline recording is best-effort: a failed write prints one `BASELINE WARNING:` and
never changes the launch result.

`shutdown-devices --batch-dir "$B"` stops by default only unprotected virtual devices
with positive `batch-booted` evidence. Unprotected `batch-inferred` devices are
reported `inferred-not-stopped` (exit 1). Verify the batch started them, then name
them by exact device ID (serial/UDID) with `--device ID`; every iOS simulator needs
this. A unique name may select a `batch-booted` device. An ambiguous selector stops
nothing and reports `ambiguous` for every match (a separate unambiguous selector
still applies). The harness never sends a frame to `foreign`, `preexisting`,
`unknown` and physical devices, even when named. The `--daemon K` option restricts
the view, `--dry-run` reports without stopping, and `--timeout-ms` defaults to 60000.

Protection matches any of `deviceId`, `name`, `identity.stableId`, `processAvdName`.
When the protected list is nonempty, the harness refuses an empty or
`Unknown (<serial>)` Android name without a process AVD name. It also refuses
`heldBy: "other_daemon"` and every other `heldBy` string locally (unknown hold labels
count as held, never as permission). The harness asks a listing daemon's `killDevice` without `force` and never signals a
device process.

| Outcome                | Meaning                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `stopped`              | Shutdown succeeded, or `device_already_stopped` confirmed the goal state; the daemon's message is retained. |
| `refused`              | The daemon refused, with its code/message.                                                                  |
| `failed`               | The request failed; no retry of a possibly completed mutation.                                              |
| `timeout`              | The request deadline expired.                                                                               |
| `protected`            | The target matches protection or its name cannot be safely checked.                                         |
| `not-batch-booted`     | The target is physical, foreign, preexisting, or unknown; selectors cannot override this.                   |
| `inferred-not-stopped` | Check the inferred device and name it by exact device ID (serial/UDID) with `--device`.                     |
| `broker-held`          | A held device is refused before sending a frame; use broker `release`.                                      |
| `held-by-other-daemon` | The inventory reports another daemon holding it; no frame is sent.                                          |
| `ambiguous`            | Multiple devices match; this selector stops nothing. Name each target by device ID (serial/UDID).           |
| `not-found`            | No device in the selected view matches the explicit selector.                                               |
| `dry-run`              | An eligible target would be stopped.                                                                        |

Every result row includes `provenance` and `bootedBy` when known. Shutdown exits 0
when every target is `stopped`/`dry-run` (including no targets) and every selected
daemon produced an inventory; otherwise 1. Inventory refusals, unparseable replies
and transport failures add top-level `daemonErrors: [{name,error}]` while devices
from healthy daemons are still processed. A daemon whose socket replies is
`alive: true` even if the reply cannot be parsed. `devices` exits 1 only when no
daemon produced an inventory.

Without inventories, `devices`/`shutdown-devices` fall back to
`shared/devices-last.json`, reporting unprotected `batch-booted` and `batch-inferred`
snapshot devices with refreshed PID evidence, exit 1 and no shutdown frames.
Selectors restrict the fallback (ambiguous gives `ambiguous`, missing gives
`not-found`), and explicitly selected protected/foreign/preexisting/unknown devices
keep their refusal rows. Run `devices` before stopping the daemon to retain
evidence. A dead daemon's snapshot never authorizes signalling a device PID; restart
only the recorded private daemon and let product recovery own cleanup.

Broker batches add `allowed`/`foreign`/`protected` classification from
`evidence/ledger.jsonl`. A ready `init.json.session` grant plus matching
`session-info` native name, device ID and platform establishes the batch binding;
protection always wins. Allowed rows include `client` and `sessionUuid`.
`devices --ledger` reads only that evidence, without sockets or host probes. The
product's `isSessionBrokerDeviceName` predicate recognizes names including legacy
`amslot-*`; the harness never hardcodes that prefix, and a matching name alone never
makes a device allowed: the batch ledger must also bind it.

Broker teardown order: `broker1 down`, `broker1 report`, stop the private daemon,
then stop the batch's caffeinate by its recorded PID. For separate plain batches use
`shutdown-devices` before daemon stop. Broker-held rows must be released through the
broker; no force bypass. After closing clients and joining release receipts,
`broker1 down` drains the broker pool through `daemon/drainBrokerPool` before checking
native absence. Devices the drain leaves running are reported as retained;
`shutdown-devices` refuses them as broker-held, and they are never signalled.

## Persistent stdio-proxy sessions

Use `proxy1` (or `in-daemon-env.sh … proxy`) with `--client NAME`, resolved through
`broker/clients.json`. The `--dir` option is exclusive with `--client` and is for plain proxies
in a separate non-broker batch; broker batches refuse sessionless proxy operations.
The `up`/`serve` commands require a private PID file naming a live process and an answering
control socket (broker clients also `session-broker/v1`). Start the private daemon
first; a proxy never wakes it.

```bash
# Gate every manual acquisition; broker1 up does this automatically.
bun scripts/manual-test/private-daemon.ts boot-gate --batch-dir "$B" --role a-phone \
  -- "$B/bin/proxy1" up --client a-phone --profile phone --expect ready < /dev/null
"$B/bin/proxy1" call --client a-phone observe '{}' < /dev/null
"$B/bin/proxy1" tools --client a-phone < /dev/null
"$B/bin/proxy1" info --client a-phone < /dev/null
"$B/bin/proxy1" status --client a-phone < /dev/null
"$B/bin/proxy1" status --all < /dev/null
"$B/bin/proxy1" release --client a-phone < /dev/null
"$B/bin/proxy1" close --client a-phone < /dev/null
```

- `up` creates a fresh attempt ID and archives prior evidence, refusing an
  already-live driver. The `--resume` flag replays the exact persisted `request.json`
  and `owner-token` bytes and never creates a replacement after a refusal. A terminal
  capacity refusal stays refused after capacity frees, so use a fresh `up`.
- `--expect ready` or `--expect failed:<code>` exits 0 for the expected outcome, 2 on
  mismatch. Without it, failed/pending outcomes are typed failure data.
- `--profile` takes an archetype name or inline device requirement JSON; `--request`
  takes SessionConfig JSON or a file path and assigns a fresh attempt ID. Both are
  for `up`/`serve` and mutually exclusive.
- `--owner driver` is the default. The `--owner disposable` option starts a recorded
  harness-owned sleep process with a process start identity. The `owner-kill
  --client NAME` command signals only that owner after identity confirmation (tests owner
  death without killing an unrelated driver or parent).
- `release --client NAME` releases the granted session with its stored token;
  `abandon --client NAME` consumes the stored request identity even if unknown to
  the daemon (240 s RPC budget). Release polls for cleanup; abandonment prints its
  receipt, which may still have `cleanupPending: true`. Verify settled cleanup and
  native absence before continuing. The `up` command captures native info best-effort within 5 s
  after readiness; `info` saves the native descriptor to `info.json` and feeds the ledger.
- `close --client NAME` closes MCP/stdin and waits up to 240 s for a released receipt
  of a granted session. The `up` command refuses while a client driver is alive. Release does not
  end the driver; run `close --client NAME` first, then retry `up`.
  A refused or failed attempt (e.g. `daemon_unavailable`,
  abandoned request) has no receipt: `close` returns at once with exit 0 and
  `release.outcome: "failed"` in `closed.json` (`receiptMissing: true` when the daemon
  holds no receipt or is unreachable). It then joins the driver's exit (5 s), including
  one resumed by `up --resume`, so the next `up` never sees "Previous attempt driver is
  alive". It signals a lingering driver only when its recorded start identity
  (`driver-identity`) still matches; otherwise `close` exits 2 without signalling.
- `status` shows initialize/live outcome, grant/profile, typed failure, owner liveness
  and `daemonSocketAlive`; `--all` prints all clients.
- `call` takes inline JSON or `@file`, `--timeout-ms` (default 900000) and `--full`,
  and requires a ready grant and live driver. Explicit selectors must match the
  grant. The `--allow-foreign-session OTHER` option permits selectors for that named ready batch
  client only, for a deliberate isolation test (the product must still refuse).
- `release`/`abandon --as-client OTHER` use that batch client's stored token to test
  wrong-owner refusals and print an isolation notice. No token flag exists; tokens
  stay in files and are redacted from output.

Each `sessions/<client>/` holds immutable `request.json`, `owner-token` (0600),
`attempts.json`, `init.json.session`, `driver.pid`, `proxy.pid`, `events.jsonl`,
`notifications.jsonl`, `in/`, `out/<id>.json`, `serve.log`, `proxy.stderr.log`, and
eventually `closed.json`; disposable owners add `owner.pid` and `owner-identity`.
Initialize has a 900000 ms default deadline (`--init-timeout-ms`). Full responses
stay in `out/`; stdout can be compact.

Clean close, explicit release, proxy owner loss and abandonment end the broker
execution through product lifecycle operations; under zero pooling the product
destroys the device. A receipt alone is not native absence proof: batch teardown
joins `cleanupPending: false` with a healthy native inventory and records `released`
and `absent` (or `leaked`) in the ledger. An info-less grant with a settled released
receipt is recorded `released` with `absence: not-verifiable` (teardown can finish
without claiming absence); a dead daemon or unavailable inventory cannot prove
absence. Android may reuse a serial for a fresh device, so retain native name and
session identity too. See the [broker lifecycle contract](../how-it-works/session-broker-experiment.md).

Known limit: the proxy receives its owner token via `--liveness-owner-token` on argv,
visible in `ps` to other users on a shared host despite output redaction.

## Raw daemon frames

`frame1 send` writes newline-delimited frames on one private control connection,
prints every answer with elapsed milliseconds, and sends the exact method named.
`daemon/*`, `ide/*`, `input/*` default to `daemon_request`; `tools/call` defaults to
`mcp_request`; `--type` overrides. Session-info uses `daemon/sessionInfo`; heartbeat
uses the external CLI keeper without claiming ownership (the daemon rejects it for a
proxy-owned session).

`--broker-binding CLIENT` reuses that batch client's unchanged request and token on
the frame connection and keeps its ready grant on exit. With `--broker-binding
/absolute/request.json`, the tool acquires a standalone session on the same connection,
heartbeats it and releases it on graceful exit. It can boot real devices, needs the
same boot gate, and is allowed only outside broker batches (untracked paths inside
batches refuse with guidance to use `--broker-binding <client>`). Templates:
`{{ownSessionId}}`, `{{clientSessionId:<name>}}` (cross-client tests),
`{{ownLivenessOwnerToken}}`; unresolved values refuse before connecting.

```bash
"$B/bin/frame1" send tools/call \
  '{"name":"observe","arguments":{"sessionUuid":"{{ownSessionId}}"}}' \
  --broker-binding a < /dev/null
"$B/bin/frame1" send tools/call \
  '{"name":"observe","arguments":{"sessionUuid":"{{clientSessionId:b}}"}}' \
  --broker-binding a --expect-refused < /dev/null
"$B/bin/frame1" send tools/call '{"name":"startDevice","arguments":{}}' \
  --broker-binding a --expect-refused < /dev/null
"$B/bin/frame1" send daemon/releaseBrokerSession '{"sessionId":"{{ownSessionId}}"}' \
  --broker-binding a --token-of b --expect-refused < /dev/null
```

`--expect-refused` (send mode only) requires every response to be an error with a
product refusal code or message (success or unrelated errors exit 2). Product
refusal codes: `device_outside_broker_grant` (labels and unbound devices),
`device_outside_bound_session` (a bound connection naming another session or device,
as in the `cross-client-isolation-live` probe), `read_session_not_bound` (a read naming
a session another connected client owns) and `session_ownership_lost`.
Lifecycle probes accept only `{}` or an object containing only the client's own
`sessionUuid`; device names and selectors refuse before sending. Resources/list,
`automobile:devices/*` reads and `--allow-selector` remain forbidden. The `--token-of
OTHER` option changes only the user status/release isolation frames to another batch
client's stored token (binding and heartbeats keep their own). Tokens are redacted
and a notice is printed.

The `--hold-ms` option defaults to 0. The `--mode cancel` or `cancel-after:<ms>`
mode destroys the socket (standalone grants end through owner loss). The
`cancel-keep-open[:<ms>]` mode (read window default 5000 ms) waits `--cancel-after-ms` (default 0), sends same-connection
`daemon/cancelRequest` for each ID, prints answers and a cancelled/answered summary,
and closes gracefully. Deliberate cancel exits 0; missing transport exits 3. Send
mode awaits every requested answer. Repeatable `--then '<method> <params
json|@file>'` sends sequentially after the initial replies (send mode only).
The `--timeout-ms` option defaults to 30000, `--count` to 1. Host restart/maintenance frames
require `--allow-host-mutation`. No raw frame bypasses broker ownership or resident
protection.
