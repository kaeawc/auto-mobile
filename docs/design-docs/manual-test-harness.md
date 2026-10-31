# Manual-test harness

Use the harness for a manual batch that needs isolated daemons, persistent stdio
proxy executions, direct control frames, or recording and stream sockets. It keeps
connection and evidence visible when testing ownership refusals, broker session
confinement, cancellation, and observer liveness.

Use `scripts/mcp-drive.ts` for a one-shot MCP plan. Use
[Live device acceptance](live-device-acceptance.md) for its signed, disposable
exact-device acceptance matrix and the broker lifecycle lane below; the harness
retains connection evidence, acceptance adds signed evidence assertions.

## Hard rules

- Never touch the resident daemon: its default socket, port 3000, or
  `~/.auto-mobile`. Run every client through `in-daemon-env.sh` or a harness CLI
  with the initialized private environment.
- Never use `pkill` or `killall`. Stop only daemons you started, using
  `private-daemon.ts stop` for that batch and daemon number.
- Broker batches never make sessionless device calls. A ready grant and live driver
  are required; pending or failed acquisition never falls back to generic acquisition.
  Broker clients refuse `startDevice`, `provisionDevice`, `getAndroid`, `getApple`,
  `killDevice`, device inventory resources, and `--allow-selector`.
- Release broker devices through `proxyN release --client NAME` or `broker1 down`.
  Zero pooling destroys the native device through the product journal; verify the
  terminal receipt and native absence before the next scenario. Never delete an
  AVD, simulator, directory, or batch evidence yourself, signal device processes,
  pass `force`, or use `adb emu kill` (it hung under load in batch 20261013a).
- Record protected devices with repeatable `init --protect NAME_OR_ID`. Protection
  wins over ledger ownership; a broker-looking name alone never authorizes access
  or cleanup.
- Keep one actor per granted device and one broker daemon per batch. `start`
  refuses an already-live recorded PID; the broker owns its host lock in the
  private coordination namespace. Report unaccounted-inventory startup refusals;
  do not remove other devices to make startup pass. Private paths do not isolate
  the host's AVD/simulator set.
- For separate plain-proxy tests, device acquisition requires explicit `avdName`
  (Android) or `deviceId` (UDID/serial); `name` alone is a matcher and is refused.
  `--allow-selector` is only a deliberate selection-test override in plain mode.
- Never pass daemon flags to a stdio proxy (a startup-option mismatch can restart
  the daemon). Record daemon flags with `init --daemon-arg`, or one-off via
  `private-daemon.ts start --`.
- Never rebuild `dist/` while a batch's daemons run. Build first, then start the
  batch from one explicit entry script.

## Initialize and run private daemons

Run from the repository root after building the entry script, with unused ports,
an absolute evidence directory and a short socket root. Redirect stdin with
`< /dev/null` when invoking from an agent tool call.

Use `init --broker-batch /absolute/broker-batch.json --count 1` for the broker
harness: daemon 1 is the sole broker, and device scenarios and broker acceptance
require exactly one daemon total. The batch input has `schemaVersion: 1`, `limits`
(`totalDeviceCap`, `sessionCap`, `idlePoolCap`), `reuseCleanDevices`, optional
`reuseAndroidCleanDevices`, explicit per-platform `defaults`, and a `clients`
array. Each client has a unique `name` matching `^[a-z0-9-]{1,32}$`, `platform`,
and optional `hardware` (archetype string or product hardware selector), `os`
(product requirement contract), `idleTimeoutMs`, `preparationTimeoutMs`. The
harness uses the product parsers; see [Session requirements](../design-docs/session-requirements.md)
and the [session broker operator/consumer contract](../design-docs/session-broker-experiment.md).

The batch also carries the product's catalog classification keys, validated by the
host-config parser and copied into `broker/host-config.json`:
`androidProfileArchetypes` (AVD profile id to `phone`, `tablet`, or `foldable`, e.g.
`{ "medium_phone": "phone" }`) and `iosClassifications` (simulator device type
identifier to model type). Omit them and the first acquisition fails with
`catalog_metadata_invalid` ("lacks current archetype metadata").

Android `os` values are the release major or version (`{ "kind": "major", "major": 16 }`
with `preferredVersion: "16"`), never the API level (36). Among installed images of
the same release the resolver prefers `google_apis` over `google_apis_playstore`,
which can stay adb `unauthorized` for many minutes after boot.

`--max-devices` defaults to **2**, hard cap **4**, and must cover `totalDeviceCap`.
Zero pooling is the default (`idlePoolCap: 0`, `reuseCleanDevices: false`,
`reuseAndroidCleanDevices: false`). `init --allow-reuse` only permits nonzero
pooling; there is no named clean-reuse runner scenario, and the scenario/acceptance
adapter requires zero pooling. Do not use reuse for the ordinary batch or claim
destruction evidence from it.

```bash
B="$PWD/scratch/manual-broker-batch"
bun scripts/manual-test/private-daemon.ts init --batch-dir "$B" \
  --count 1 --base-port 3160 --aux-root /tmp/am-manual-broker \
  --server "$PWD/dist/src/index.js" --broker-batch /absolute/broker-batch.json \
  --max-devices 2 --protect protected-device-name \
  --daemon-arg --plan-execution-lock-scope --daemon-arg session \
  --daemon-arg --tool-call-recording < /dev/null
bun scripts/manual-test/private-daemon.ts start --batch-dir "$B" < /dev/null
"$B/bin/broker1" up --all --max-devices 2 < /dev/null
"$B/bin/broker1" status < /dev/null
"$B/bin/broker1" down < /dev/null
"$B/bin/broker1" report < /dev/null
bun scripts/manual-test/private-daemon.ts stop --batch-dir "$B" --daemon 1 < /dev/null
```

`init` only writes files; it starts no process. Topology:

```text
<batch>/batch.json                 private manifest, broker daemon 1
<batch>/broker/host-config.json    rendered operator defaults and limits (0600)
<batch>/broker/clients.json        client profiles, initial request IDs, token paths (0600)
<batch>/daemon1/env.sh             private paths; pid.txt mirrors the started daemon
<batch>/bin/am1 proxy1 frame1 aux1 broker1
<batch>/sessions/<client>/         request, owner token, attempts and connection evidence
<batch>/evidence/ledger.jsonl      append-only grants/native bindings/cleanup evidence
```

`amN cli …` invokes the one-shot product CLI; `proxyN`, `frameN` and `auxN` select
daemon N; every `brokerN` wrapper selects daemon 1. Run broker clients through
`proxy1`/`frame1`. `wrappers --batch-dir "$B"` regenerates the wrappers alone; a
batch command uses `MT_BATCH` from its wrapper.

`broker-batch.ts up` (`broker1`) defaults to all clients, accepts `--clients a,b` or
`--all`, `--stagger-ms N` (default 0) and `--max-devices N`. It reruns
`preflight --strict`, requires a live `session-broker/v1` socket, and holds a
boot-gate permit through every proxy initialization. Planned ready clients finish
before clients expected to get `capacity_exhausted` start (extra clients deliberately
test refusals). `capacity_exhausted` reports `retryable: true` with
`retryRequires: "new_request_id"`: replaying the same request ID returns the
identical stored refusal, so a retry needs a fresh ID. The acquisition deadline is
26 minutes including the boot gate; a timeout signals no process. Inspect `status`,
then `down` before another batch. `down` closes clients in reverse start order,
waits for receipts and verifies native absence (240 s budget). `report` writes
`evidence/broker-report.json` (outcomes, timings, ledger data).

`--env K=V` is repeatable for all daemons; `--daemon-env N:K=V` overrides per
daemon. `--daemon-arg TOKEN` records each daemon argv token (`N:TOKEN` selects a
daemon; `--daemon-arg=--debug` also works). Restarts reuse recorded env and argv;
`start -- …` adds one-off argv. The harness owns `--port` and `--strict-port`.

`start` refuses a recorded live PID, then mirrors the daemon's JSON PID to
`daemonN/pid.txt`. `stop` confirms identity through `ide/status` on the private
control socket, sends SIGTERM to the recorded PID, and waits up to `--wait-ms`
(default 30000), printing one JSON line with `outcome` (`stopped`, `still-alive`,
`gone-before-signal`) and `via` (`signal`, `product-cli`, `none`). When identity is
not confirmed it delegates to the product CLI (`amN daemon stop` remains the product
stop path). It never escalates to SIGKILL; exit 1 means `still-alive` and preserves
`pid.txt`, success removes it. `stop --wait-ms 0` signals and reports `still-alive`
unless the daemon is already gone.

For the explicit crash-recovery test only: `private-daemon.ts stop --batch-dir "$B"
--daemon 1 --crash` sends SIGKILL only to this batch's recorded daemon PID after
confirming PID, socket and PID file through `ide/status`, matching
`daemon-start.json`, and re-checking the recorded process start identity right
before signalling. It never delegates, signals children or process groups, or kills
by name; missing or mismatched identity refuses. Success reports `crashed`.

`status` reports JSON/plain PID agreement (`pidTxt`: `ok`, `missing`, `stale`),
liveness, socket response, port and env file. `status --devices` appends host
inventories and the daemon's own view (`daemonDevicesMethod:
"daemon/availableDevices"`); it is read-only apart from that method's inventory
ownership/discovery refresh and boots or claims no device. Android inventory reads
`host:devices-l` over the local ADB server socket without launching `adb` (skipped
when no server listens). Each diagnostic failure is returned as evidence.

Restart means `stop` then `start`; wrappers refuse `daemon start*` and `daemon
restart*` shorthands. `env --batch-dir "$B" --daemon 1` prints an env file path.
`in-daemon-env.sh --cd /absolute/existing/dir` opts into changing cwd (otherwise it
preserves the caller's); its `cli` shorthand matches `amN cli`.

```bash
"$B/bin/frame1" session-info your-session-uuid < /dev/null
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  --cd "$PWD" daemon status < /dev/null
bun scripts/manual-test/private-daemon.ts status --batch-dir "$B" --devices < /dev/null
bun scripts/manual-test/private-daemon.ts wrappers --batch-dir "$B" < /dev/null
```

### Path policy

Every client requires all initialized `state` variables and refuses host defaults,
canonical aliases and resident socket/PID/lock basenames. The audited policy is
exhaustive for configurable product state destinations:

| Kind     | Variables                                                                                                                                                                  | Harness policy                                                                                                                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`  | `AUTOMOBILE_DATA_DIR`, `AUTOMOBILE_LOG_DIR`, `AUTOMOBILE_DB_DIR`, `AUTOMOBILE_COORDINATION_DIR`                                                                            | Required per-daemon defaults under the evidence root.                                                                                                                                                                                                             |
| `state`  | `AUTOMOBILE_ADB_SERVER_COORDINATION_DIR`                                                                                                                                   | Batch shared default, or per-daemon with `--split-adb-coordination`.                                                                                                                                                                                              |
| `state`  | `AUTOMOBILE_AUX_SOCKET_DIR`, `AUTOMOBILE_DAEMON_SOCKET_PATH`                                                                                                               | Short auxiliary root and `d.sock`.                                                                                                                                                                                                                                |
| `state`  | `AUTOMOBILE_DAEMON_PID_FILE_PATH`, `AUTOMOBILE_DAEMON_LOCK_FILE_PATH`, `AUTOMOBILE_DAEMON_TOKEN_FILE_PATH`, `AUTOMOBILE_DAEMON_LAUNCH_LOG_PATH`                            | Per-daemon PID, lock and launch log.                                                                                                                                                                                                                              |
| `state`  | `AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR`, `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA`                                                                                            | Private path selection only; optional private overrides.                                                                                                                                                                                                          |
| `opt-in` | `AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR`, `AUTOMOBILE_PLAN_HEALTH_DIR`, `AUTOMOBILE_TOOL_OUTPUTS_DIR`, `AUTOMOBILE_STARTUP_BENCHMARK_OUTPUT`                                  | Unset by default; strip inherited values in both spellings. Explicit `--env`/`--daemon-env` requires an absolute private path. These enable exchange capture, plan health files/results, tool-output artifacts, or benchmark output when benchmarking is enabled. |
| `unset`  | `AUTOMOBILE_DB_PATH`, `AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH`                                                                                                               | Strip competing overrides in both spellings.                                                                                                                                                                                                                      |
| `input`  | `AUTOMOBILE_CTRL_PROXY_APK_PATH`, `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH`, `AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH`, `AUTOMOBILE_CWEBP_PATH`, `AUTOMOBILE_DWEBP_PATH`          | Caller-selected read-only artifacts/executables; no harness defaults.                                                                                                                                                                                             |
| `input`  | `AUTOMOBILE_DAEMON_LAUNCH_CWD`, `AUTOMOBILE_IOS_CODE_SIGN_ENTITLEMENTS_PATH`, `AUTOMOBILE_MIGRATIONS_DIR`, `AUTOMOBILE_NETWORK_FILTER_APP_PATH`, `AUTOMOBILE_PROJECT_ROOT` | Caller-selected working directory or build/signing inputs.                                                                                                                                                                                                        |
| `input`  | `AUTOMOBILE_UNIT_TEST_ISOLATED_DATA_DIR`                                                                                                                                   | Test preload isolation marker, not a state destination.                                                                                                                                                                                                           |
| `input`  | `AUTOMOBILE_SESSION_BROKER_CONFIG`, `AUTOMOBILE_SESSION_CONFIG`                                                                                                            | Harness-owned: inherited values stripped; forbidden in `--env`/`--daemon-env`. Host config is set only on broker daemon 1 start; client requests use `--client`.                                                                                                  |
| `input`  | `AUTOMOBILE_FFMPEG`, `AUTOMOBILE_VIDEO_SERVER_JAR`, `AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER`, `AUTOMOBILE_IOS_PROTOTYPE_AGENT`                                               | Caller-selected read-only encoder/helper inputs.                                                                                                                                                                                                                  |

Legacy managed-slot configuration and `AUTO_MOBILE_*` values are stripped. `env.sh`
unsets opt-ins unless configured, so sourcing it cannot silently enable them.
Clients validate opt-in paths only when supplied and discard inherited opt-ins;
daemon manifest overrides are retained on launch.
`scripts/manual-test/productPathEnv.ts` is the registry, checked exhaustively
against product env reads with its sorted non-path list. Harness entry scripts
preserve explicit `stderr` sinks. File logging before product imports requires an
explicit absolute log directory outside both home defaults, checked lexically and
through existing ancestors' realpaths; all other cases (invalid sink values,
data-dir-only environments) force the canonical stderr sink. Child environments
restore every harness sink override so private daemons log to their private files.

Control sockets live under the short aux root, normally
`/tmp/am-mt-<hash>/<N>/d.sock`, **not under the batch directory**. Each daemon
isolates data, logs, database, coordination, auxiliary sockets, control socket,
PID, lock, launch log and iOS cache/build paths.

Known uncovered path: the libwebp cache has no environment override
(`src/utils/image/webp/WebpBinaryResolver.ts`), so a private daemon that downloads
libwebp writes to `~/.auto-mobile/libwebp`. Supply `AUTOMOBILE_CWEBP_PATH` and
`AUTOMOBILE_DWEBP_PATH` to avoid it.

Daemons still share the host's adb server, AVD inventory and simulator set. By
default the batch uses **one shared adb-server coordination directory**; the broker
also has a private per-daemon coordination namespace for its host lock and registry.
`init --split-adb-coordination` is only for scenarios whose daemons must not see
each other's coordination state (a split registry made batch 20261012a report a
false 7-of-6 capacity finding, #11905); it creates no separate adb servers.

## Host preflight and staggered boots

`preflight --batch-dir "$B" [--strict]` reports platform, power source and charge,
system-wide sleep assertions, lid state and clamshell sleep, low-power mode (from
`lowpowermode` or `powermode`; absence of both is not a warning), the three load
averages, CPU count and free/total memory bytes. macOS reads `pmset -g batt`,
`pmset -g assertions`, `pmset -g` and `ioreg`; other platforms report those sections
unsupported; failed readers carry `unavailable` reasons. It needs a private batch
path but no `batch.json`, prints one JSON document and exits 0 (`--strict` exits 1
when warnings exist).

`init` (after writing the batch) and `start` (before launch) run the same checks as
warnings, record `shared/preflight-<ms>.json`, and print `PREFLIGHT WARNING:` lines
plus the caffeinate command; failures never refuse initialization or change the
launch result.

```bash
bun scripts/manual-test/private-daemon.ts preflight --batch-dir "$B" --strict
nohup caffeinate -dims > /dev/null 2>&1 & echo $! > "$B"/shared/caffeinate.pid
```

Keep AC attached and the lid open or an external display connected: caffeinate
cannot prevent a clamshell sleep on battery. A host sleep expires every idle session
on wake, so timings across a sleep are invalid (batch 20261013a, #12212); discard
timings measured during a host load spike too.

Every broker acquisition holds a `boot-gate` permit across the whole proxy `up`,
including failed preparation (`broker1 up` and device scenarios do this for you):

```bash
bun scripts/manual-test/private-daemon.ts boot-gate --batch-dir "$B" --role a-phone \
  -- "$B/bin/proxy1" up --client a-phone --expect ready < /dev/null
```

Roles match `^[A-Za-z0-9._-]{1,64}$`. Defaults: `--max-concurrent 1` (1-8),
`--max-load` twice the CPU count, `--min-interval-ms 30000`, `--timeout-ms 600000`,
`--poll-ms 2000`; keep concurrent acquisitions within the batch device cap. Each role
takes a shared `permit-N.lock`, waits for 1-minute load strictly below the threshold
and the last-grant interval, then records `shared/boot-gate/last-grant.json`. Dead
holders' permits are reclaimed by the canonical file lock; with multiple permits the
minimum interval is best-effort; signal termination leaves a permit lock until its
PID is gone.

A wrapped command holds the permit until it finishes and propagates its exit code
(command tokens keep the caller's environment and are not daemon flags; an empty
`--` refuses). A bare gate releases at exit and its JSON says so. Grant JSON has
`role`, `outcome`, `permit`, `waitedMs`, `loadAverage1m`, `maxLoad`; a timeout
records `waitingFor` (`permit`, `load`, `interval`), releases the permit, runs
nothing and exits 2. Gate-only success exits 0.

## Devices and teardown

`devices --batch-dir "$B" [--daemon K] [--timeout-ms 30000]` lists only running
devices with a nonempty runtime device ID and lifecycle `booting`, `booted` or
`shutting-down`. JSON: `batchDir`, `protectedDevices`, baseline availability, daemon
liveness/errors, and rows with `deviceId`, `name`, `identity.stableId`, `platform`,
`isVirtual`, `seenByDaemons` (visibility, not boot ownership), `pid` (+ optional
`pidReason`; null for iOS and physical), `provenance`, `protected`, `poolStatus`,
`heldBy` when exposed, optional `bootedBy: "daemon<N>"` (from `MT_DAEMON`) and
`processAvdName` (the process's `-avd` argument).

Positive evidence is the `MT_BATCH`/`MT_DAEMON` environment an emulator inherits
from its private daemon, read with `ps eww -o command= -p <pid>` for the one Android
console-port listener PID `lsof` resolved (5000 ms per probe); this has not yet been
observed on a live batch. A missing PID, failed/empty read, or any iOS simulator has
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
reported `inferred-not-stopped` (exit 1): verify the batch started them, then name
them by exact device ID (serial/UDID) with `--device ID`; every iOS simulator needs
this. A unique name may select a `batch-booted` device; an ambiguous selector stops
nothing and reports `ambiguous` for every match (a separate unambiguous selector
still applies). `foreign`, `preexisting`, `unknown` and physical devices are never
sent a frame, even when named. `--daemon K` restricts the view, `--dry-run` reports
without stopping, `--timeout-ms` defaults to 60000. Protection matches any of
`deviceId`, `name`, `identity.stableId`, `processAvdName`; an empty or
`Unknown (<serial>)` Android name without a process AVD name is refused when the
protected list is nonempty. `heldBy: "other_daemon"` and every other `heldBy` string
are refused locally (unknown hold labels count as held, never as permission). The
harness asks a listing daemon's `killDevice` without `force` and never signals a
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
snapshot devices with refreshed PID evidence, exit 1 and no shutdown frames;
selectors restrict the fallback (ambiguous gives `ambiguous`, missing gives
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
`broker/clients.json`. `--dir` is exclusive with `--client` and is for plain proxies
in a separate non-broker batch; broker batches refuse sessionless proxy operations.
`up`/`serve` require a private PID file naming a live process and an answering
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
  already-live driver. `--resume` replays the exact persisted `request.json` and
  `owner-token` bytes and never creates a replacement after a refusal; a terminal
  capacity refusal stays refused after capacity frees, so use a fresh `up`.
- `--expect ready` or `--expect failed:<code>` exits 0 for the expected outcome, 2 on
  mismatch. Without it, failed/pending outcomes are typed failure data.
- `--profile` takes an archetype name or inline device requirement JSON; `--request`
  takes SessionConfig JSON or a file path and assigns a fresh attempt ID. Both are
  for `up`/`serve` and mutually exclusive.
- `--owner driver` is the default; `--owner disposable` starts a recorded
  harness-owned sleep process with a process start identity, and `owner-kill
  --client NAME` signals only that owner after identity confirmation (tests owner
  death without killing an unrelated driver or parent).
- `release --client NAME` releases the granted session with its stored token;
  `abandon --client NAME` consumes the stored request identity even if unknown to
  the daemon (240 s RPC budget). Release polls for cleanup; abandonment prints its
  receipt, which may still have `cleanupPending: true`. Verify settled cleanup and
  native absence before continuing. `up` captures native info best-effort within 5 s
  after readiness; `info` saves the native descriptor to `info.json` and feeds the ledger.
- `close --client NAME` closes MCP/stdin and waits up to 240 s for a released receipt
  of a granted session. `up` refuses while a client driver is alive. Release does not
  end the driver; run `close --client NAME` first, then retry `up`.
  A refused or failed attempt (e.g. `daemon_unavailable`,
  abandoned request) has no receipt: `close` returns at once with exit 0 and
  `release.outcome: "failed"` in `closed.json` (`receiptMissing: true` when the daemon
  holds no receipt or is unreachable). It then joins the driver's exit (5 s), including
  one resumed by `up --resume`, so the next `up` never sees "Previous attempt driver is
  alive"; a lingering driver is signalled only when its recorded start identity
  (`driver-identity`) still matches, otherwise `close` exits 2 without signalling.
  `status` shows initialize/live outcome, grant/profile, typed failure, owner liveness
  and `daemonSocketAlive`; `--all` prints all clients.
- `call` takes inline JSON or `@file`, `--timeout-ms` (default 900000) and `--full`,
  and requires a ready grant and live driver. Explicit selectors must match the
  grant. `--allow-foreign-session OTHER` permits selectors for that named ready batch
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
session identity too. See the [broker lifecycle contract](../design-docs/session-broker-experiment.md).

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
the frame connection and keeps its ready grant on exit. `--broker-binding
/absolute/request.json` acquires a standalone session on the same connection,
heartbeats it and releases it on graceful exit; it can boot real devices, needs the
same boot gate, and is allowed only outside broker batches (untracked paths inside
batches refuse with guidance to use `--broker-binding <client>`). Templates:
`{{ownSessionId}}`, `{{clientSessionId:<name>}}` (cross-client tests),
`{{ownLivenessOwnerToken}}`; unresolved values refuse before connecting.

```bash
"$B/bin/frame1" send tools/call \
  '{"name":"observe","arguments":{"sessionUuid":"{{clientSessionId:b}}"}}' \
  --broker-binding a < /dev/null
"$B/bin/frame1" send tools/call '{"name":"startDevice","arguments":{}}' \
  --broker-binding a --expect-refused < /dev/null
"$B/bin/frame1" send daemon/releaseBrokerSession '{"sessionId":"{{ownSessionId}}"}' \
  --broker-binding a --token-of b --expect-refused < /dev/null
```

`--expect-refused` (send mode only) requires every response to be an error with a
product refusal code or message (success or unrelated errors exit 2). Product
refusal codes: `device_outside_broker_grant` (labels and unbound devices),
`device_outside_bound_session` (a bound connection naming another session or device,
as in the `cross-client-isolation-live` probe) and `session_ownership_lost`.
Lifecycle probes accept only `{}` or an object containing only the client's own
`sessionUuid`; device names and selectors refuse before sending. Resources/list,
`automobile:devices/*` reads and `--allow-selector` remain forbidden. `--token-of
OTHER` changes only the user status/release isolation frames to another batch
client's stored token (binding and heartbeats keep their own); tokens are redacted
and a notice is printed.

`--hold-ms` defaults to 0. `--mode cancel` or `cancel-after:<ms>` destroys the
socket (standalone grants end through owner loss). `cancel-keep-open[:<ms>]` (read
window default 5000 ms) waits `--cancel-after-ms` (default 0), sends same-connection
`daemon/cancelRequest` for each ID, prints answers and a cancelled/answered summary,
and closes gracefully. Deliberate cancel exits 0; missing transport exits 3. Send
mode awaits every requested answer. Repeatable `--then '<method> <params
json|@file>'` sends sequentially after the initial replies (send mode only).
`--timeout-ms` defaults to 30000, `--count` to 1. Host restart/maintenance frames
require `--allow-host-mutation`. No raw frame bypasses broker ownership or resident
protection.

## Broker scenarios and acceptance

`broker-scenario.ts list` reports the registry and class. `run NAME` selects an
isolated in-memory broker with a fake native port unless the entry is device-only;
device entries always require explicit `--device` (for names in both classes
`--device` selects the device variant). Fake runs create no daemon or device and do
not prove native isolation. Device runs require an already-running private broker
batch, strict preflight, capability probing, owned persistent proxies, caps and boot
permits; the batch needs positive `totalDeviceCap <= --max-devices`, `sessionCap >=
totalDeviceCap` and zero pooling. Start with no live client drivers and verified
cleanup of earlier ledger grants; run scenarios separately from `broker1 up` traffic.

```bash
bun scripts/manual-test/broker-scenario.ts list
bun scripts/manual-test/broker-scenario.ts run capacity-refusal-and-replay \
  --batch-dir "$B"
bun scripts/manual-test/broker-scenario.ts run parallel-acquire \
  --batch-dir "$B" --device --max-devices 2 --dry-run
bun scripts/manual-test/broker-scenario.ts run daemon-restart-with-live-sessions \
  --batch-dir "$B" --device --crash --max-devices 2 < /dev/null
```

`--dry-run` prints the plan without execution or evidence writes. `--batch-dir` (or
`MT_BATCH`) selects the evidence root; `--max-devices` defaults to 2, hard 4;
`--crash` is restricted to `daemon-restart-with-live-sessions --device`. Evidence is
`evidence/<scenario>/summary.json`: redacted requests, replies/errors, durations,
ledger deltas and explicit assertion limits.

| Scenario                            | Class         | Expected evidence                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parallel-acquire`                  | device        | At least two clients within cap; distinct session/native identities, matching profiles, observe per client, release and absence.                                                                                                                                                                                                                                |
| `capacity-refusal-and-replay`       | fake + device | Device batch needs capacity + 1 clients, where capacity is device ops `totalDeviceCap`; cap winners plus one retryable refusal (`retryRequires: "new_request_id"`) with no tools/grant; same refusal on replay after release; fresh attempt succeeds.                                                                                                           |
| `release-destroy-verification`      | fake + device | Released receipt, cleanup complete, native absence, old session refused, fresh session/native identity. Fake proves only fake-native absence.                                                                                                                                                                                                                   |
| `owner-death-and-abandon`           | fake + device | Fake: abandon pending/unknown/ready identities and join cleanup. Device: disposable-owner exit closes the proxy (its `closed.json` reason is the transport-local `proxy_exited_or_transport_closed`) and the broker's terminal receipt is `session_owner_exited`; ready abandonment yields `session_request_abandoned` and old proxy refusal.                   |
| `cross-client-isolation`            | fake          | Wrong-token status/release/rebind and generic lifecycle tools refused; legitimate client still observes. Use raw bound frames for live cross-client checks.                                                                                                                                                                                                     |
| `daemon-restart-with-live-sessions` | device        | Graceful restart preserves session/native identities and observe. `--crash`: interrupted requests become terminal `session_owner_exited`, replay is identical, destruction precedes fresh successors.                                                                                                                                                           |
| `#12451-restart-handoff`            | device        | Graceful restart handoff using the same restart assertions; no crash flag on this alias.                                                                                                                                                                                                                                                                        |
| `#12452-retryable-prep-failure`     | fake          | Retryable `catalog_unavailable` replay is unchanged; unknown archetype fails validation; disabled Duo is terminal `capability_disabled`.                                                                                                                                                                                                                        |
| `#12452-prep-timeout`               | device        | 1 ms preparation timeout is retryable (`timeout`, `daemon_unavailable` or `provision_failed`, whichever the deadline hits first) with settled cleanup; disabled Duo is a nonretryable `capability_disabled` control, requiring a batch `iosClassifications` entry mapping a simulator device-type identifier to `modelType: { family: "duo", variant: "duo" }`. |
| `#12491-pid-reuse-fencing`          | fake          | Reused PID/start identity refuses before allocation; matching identity acquires and releases.                                                                                                                                                                                                                                                                   |
| `#12491-pid-reuse-positive-control` | device        | Recorded live disposable owner is accepted, then owner death closes proxy and destroys its device.                                                                                                                                                                                                                                                              |

The live adapter marks destruction/handoff resource samples **`not-verifiable`**
until the product exposes a read-only resource-state diagnostic. Native inventory
and receipts still verify their own assertions but do not prove internal resource
transitions or every instant of a restart handoff, so a passed summary is not full
resource-state qualification.

`live-device-acceptance.ts --scenario broker` uses the same adapter and runs
`parallel-acquire`, `release-destroy-verification`, `capacity-refusal-and-replay`
and `daemon-restart-with-live-sessions` against the existing private batch (it
creates no daemon). Select enough clients for two parallel winners and capacity + 1
for the refusal check; `--clients a,b,c` filters batch clients, `--only` takes a
comma-separated subset of the four names, `--allow-crash` adds the restart crash
variant. There is no `--platform` flag; platform comes from client requirements.

```bash
AUTOMOBILE_ACCEPTANCE_LIVE=1 bun scripts/live-device-acceptance.ts \
  --scenario broker --broker-batch "$B" --max-devices 2 \
  --confirm-live --test-owned-devices < /dev/null
```

`--dry-run` prints a plan without live confirmation. Live runs require all three
confirmation inputs, keep caps at default 2/hard 4, write signed
`evidence/acceptance-broker-<id>.json` and per-scenario summaries, and preserve
`not-verifiable` assertions. The full exact-device lane remains separate; see
[Live device acceptance](live-device-acceptance.md).

## Slot-era to broker mapping

| Slot-era interface or assumption                       | Broker equivalent                                                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--managed-binding`                                    | `--broker-binding <client-or-request.json>` on the same frame connection.                                                                                     |
| `proxy-session --config <managed-slot json>`           | `--client NAME`, optionally `--request <SessionConfig-json-or-path>` for a fresh attempt.                                                                     |
| `{{ownSessionId:<slotIndex>}}`                         | `{{ownSessionId}}` for the single grant; `{{clientSessionId:<name>}}` for another batch client.                                                               |
| `init.json.managedSlots`                               | `init.json.session` (flat outcome, UUID, profile, failure, cleanup).                                                                                          |
| `heldBy: managed_slot` rows                            | Broker-held: tolerate all hold strings and refuse shutdown locally; use `release --client NAME`.                                                              |
| Boot-gate “slot”                                       | “permit”: `permit-N.lock`, JSON `permit`, `waitingFor: permit`.                                                                                               |
| `AUTOMOBILE_MANAGED_SLOT_*` env                        | Harness-owned `AUTOMOBILE_SESSION_BROKER_CONFIG` / `AUTOMOBILE_SESSION_CONFIG`; inherited values scrubbed.                                                    |
| “Managed release retains the slot's device assignment” | Zero-pooling release destroys the device; verify receipt and native absence.                                                                                  |
| `amslot-*` names                                       | Recognized through the product predicate for cleanup classification, never hardcoded in the harness; name alone never allows a device, the batch ledger does. |

## Auxiliary sockets and observer sessions

`aux` derives recording, video and WebRTC paths from the private aux directory. The
product's WebRTC resolver supports a socket-path override; initialized harness
environments clear inherited overrides to keep all sockets private. WebRTC requests
reuse `sendWebRtcStreamRequest`.

Recording `start`, `stop` and `status` require `--session-uuid`: a device session
(the owner for start/stop; any live device session may read status). A retained stop
result can still be fetched with its former owner's UUID. Get `sessionUuid` from
`init.json.session` printed by `proxy up`/`status` or `amN daemon active-sessions
--json`. Recording refuses `--observer` at parse time. The socket is
`device-gesture-recording.sock`; the tools are `recordToolCalls` and
`recordDeviceGestures`, with daemon flag `--tool-call-recording`.

For broker video/WebRTC use `--session-uuid` for the granted session. In a separate
plain batch, `--observer` provides a sessionless viewer: it mints a UUID, registers
it on the control socket, heartbeats every 2000 ms by default (`--heartbeat-ms` must
be below the returned heartbeat timeout), injects `sessionUuid`, and releases on exit.
`--observer-name` sets the client name; observer and explicit session UUID are
mutually exclusive. Observers grant viewing admission, not device ownership; see
[Streams](../using/device-ownership.md#streams-need-an-observer-registration-not-a-session)
and [Recordings](../using/device-ownership.md#recordings).

```bash
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  aux recording status --session-uuid your-session-uuid
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  aux recording start --device-id your-device-id --platform android \
  --plan-name manual-plan --session-uuid your-session-uuid
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  aux recording stop --recording-id your-recording-id --session-uuid your-session-uuid
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  aux video '{"action":"subscribe","deviceId":"your-device-id","platform":"android"}' \
  --observer --hold-ms 5000
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  aux webrtc list --observer --timeout-ms 45000
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  aux webrtc start '{"deviceId":"your-device-id","whipEndpoint":"https://example.com/whip"}' \
  --observer
```

Recording prints one full response line. Video prints its acknowledgement, then
counts bytes after it for `--hold-ms` (default 5000) or until the server closes, and
prints `{ack, bytesAfterAck, closedBy}` (binary newlines counted as bytes; the
product exports no packet decoder, so no packet counts are inferred). WebRTC prints
the full response; `start` requires `whipEndpoint`; other actions are `stop`,
`status`, `list`, `await`.

Exit codes. Frame and aux: 0 success, 1 typed refusal, 2 usage or
private-environment/device-start guard, 3 timeout or connection failure.
Private-daemon: 0 success/status; 1 typed non-success (daemon still alive, device not
stopped, inventory errors, `preflight --strict` with warnings); 2 usage/guard/I/O or
`boot-gate` wait deadline; `start` propagates the product launch exit code;
`boot-gate -- COMMAND` exits with the command's. Proxy: 0 success/status, 1
failed/refused response, 2 usage/guard/wait deadline, 3 serve lost its transport, 4
serve initialization failed. Inspect full evidence rather than treating exit 0 as
device-side proof. All three client CLIs support `--help`, `-h`, `help` and
`<subcommand> --help` on stdout (exit 0) listing flags, defaults, examples and exit
codes; parse errors go to stderr with a `--help` pointer and exit 2.

## Python MCP SDK stdio clients

<!-- Language exception: the TypeScript-only rule applies to application code. This manual-test tooling uses Python because Python anyio/mcp context-close failures cannot be reproduced by a TypeScript client. -->

Use a separate non-broker private batch: `startDevice` and inventory-resource calls
are forbidden in a broker batch. `scripts/manual-test/python/` retains every request
and full response while reproducing #11951 (stdio close) and #11950 (multiline
typing). It uses the official Python `mcp` SDK, locked to 2.3.0: the TypeScript
`proxy-session.ts` and `@modelcontextprotocol/client` cannot reproduce Python/anyio
close-path errors, and the official SDK is the thing under test. Tests use
`unittest` like the repo's other Python tests; the only third-party imports are
`mcp` and its dependency `anyio`; no `claude-agent-sdk` or LLM loop is needed.

Initialize and start a private daemon first. The Python client resolves its launch
through `in-daemon-env.sh` and `harness-guard.ts` (the TypeScript guard owns all
private namespace rules); resolve requires a live daemon pid file and a responding
private control socket. The proxy receives only the server entry point, with no
daemon startup flags. Real and fake modes both check every device-start call
(including `afterPeerClosed`) before spawning; selector-only starts need
`--allow-selector`. There is no arbitrary command, socket, port or real-server
environment override.

Set up Python 3.11+ inside an existing absolute batch directory. The setup script
never creates the batch directory, defaults to no batch, never deletes a venv, and
prints just the interpreter path on stdout. Its optional version override installs
after the hashed lock and reports **UNLOCKED** on stderr (use it only to compare SDK
lines; the 1.30.0 line reproduces the transport failure).

```bash
B=/absolute/private/batch
PY="$(bash scripts/manual-test/python/setup-venv.sh --batch-dir "$B")"
# Optional comparison (reuses this batch's venv):
PY="$(bash scripts/manual-test/python/setup-venv.sh --batch-dir "$B" --mcp-version 1.30.0)"
printf '%s\n' "$PY"
```

Single-client close modes all run the script first, except `mid-call`, which starts
the last call/read without awaiting it and leaves the contexts after the delay.
`normal` leaves the contexts; `after-server-exit` closes the captured child's stdin
and waits for exit; `sigterm-server` and `kill-server` signal only that captured
child, then wait; `--server-exit-wait-ms 0` races the signal with context close. A
failed process capture refuses modes needing a process handle before any step (no pid
is guessed). SDK contexts always close in their owning task; close deadlines kill
only the captured child and report `CLOSE_HANG`.

```bash
B=/absolute/private/batch
PY="$B/python-venv/bin/python"
SCRIPT=scripts/manual-test/python/scripts/observe-then-close.json
for MODE in normal after-server-exit mid-call sigterm-server kill-server; do
  "$PY" scripts/manual-test/python/mcp_stdio_client.py \
    --batch-dir "$B" --daemon 1 --script "$SCRIPT" --var platform=android --var deviceId=your-device-id \
    --out-dir "$B/python-$MODE" --close-mode "$MODE" \
    --server-exit-wait-ms 5000 --mid-call-delay-ms 200 \
    --init-timeout-ms 60000 --step-timeout-ms 60000 --close-timeout-ms 30000
done
```

For two emulators sharing one private daemon, each stdio server belongs to its own
asyncio task and both initialize before traffic. `a-first`: A closes as soon as its
steps finish while B continues and runs `afterPeerClosed` after A's close plus
`--stagger-ms`; `b-first` mirrors it; `simultaneous` holds both at a barrier and
offsets B by the stagger. Repeat five lifetimes to retain each close separately:

```bash
B=/absolute/private/batch
PY="$B/python-venv/bin/python"
"$PY" scripts/manual-test/python/two_clients.py \
  --batch-dir "$B" --daemon 1 \
  --script scripts/manual-test/python/scripts/sendkeys-multiline.json \
  --var-a platform=android --var-a deviceId=emulator-a \
  --var-b platform=android --var-b deviceId=emulator-b \
  --out-dir "$B/python-pair" --lifetimes 5 --close-order a-first --stagger-ms 200 \
  --close-mode-a normal --close-mode-b normal
```

- `observe-then-close.json`: lists tools, observes the explicit device twice, reads
  `automobile:devices/booted`, idles briefly; its peer continuation observes again.
- `sendkeys-multiline.json` requires an editor already focused: default multiline
  typing, repeated type commands in one call, clear then type, explicit `mode: "ime"`,
  three character-at-a-time calls with retries, a final observation. Retrying a typing
  error can duplicate text; inspect the retained attempts.
- Both first call `startDevice` with required `platform` and explicit `deviceId`
  variables; the stdio proxy binds the returned session and injects it into later
  calls, so observe/sendKeys omit `device`/`deviceId` (`device` is a plan label).
- `--script-a`/`--script-b` replace `--script` for asymmetric traffic. Script keys and
  operations are strict; `${name}` substitution uses `--var` (or `--var-a`/`--var-b`)
  in string values including nested arguments. Unknown keys, missing variables,
  non-object arguments and negative numbers refuse before launch. `retries` means
  extra attempts, for exceptions or `isError`.

For a dry run, replace the real launch flags with `--fake-server`; `--fake-env K=V`
applies only to the bundled fake, which uses the installed SDK's server API (FastMCP
in 1.x, MCPServer in 2.x), implements scripted tools and the `fake://status`
resource, and bounds every fake to 60 s. `FAKE_ON_EOF` accepts `exit` (default),
`write-then-exit:20` or `ignore`; `FAKE_IGNORE_SIGTERM=1` adds the force-kill case.

```bash
B=/absolute/private/batch
PY="$B/python-venv/bin/python"
"$PY" scripts/manual-test/python/mcp_stdio_client.py --fake-server \
  --fake-env FAKE_ON_EOF=write-then-exit:20 \
  --script scripts/manual-test/python/scripts/sendkeys-multiline.json \
  --var platform=android --var deviceId=fake-device --out-dir "$B/python-fake"
"$PY" scripts/manual-test/python/characterize_close.py
"$PY" scripts/manual-test/python/characterize_close.py --json --only normal
```

### Evidence

The output directory is absolute, created mode 0700; reusing one containing any named
evidence file (or `lifetime-001` for two clients) is a usage error before guard
checks or spawn. Files: `A.jsonl` (append-only, 0600, flush per record; fsync per
record except notifications, which fsync every 100 and on close), `A.identity.json`
(Python/platform/package versions, command/args, environment **keys only**, close
mode, script path and SHA256) and `A.server.stderr.log`. JSONL records
`spawn-request` and `initialize-request` before launch/initialization (retained even
when spawn fails: `exception` with `phase: "spawn"`), spawn pid, initialization, the
request before every attempt, the full `model_dump(mode="json", by_alias=True)`
response or exception, notifications when the SDK offers a handler, `server-request`
method/params, `transport-exception` details, server exit status/timing, and close.

Step timeouts bound only the wait: a timed-out attempt records `timedOut: true` and
`stillPending: true`, counts as failed, and may retry while its request continues;
the eventual result is a `late-response`/`late-exception` with the same
index/attempt and `lateByMs`. After context exit pending requests get a bounded 3 s
wait with `afterClose: true`; the rest are cancelled and recorded `abandoned`.
Summaries count `lateResponses` and `abandonedRequests`; step stdout includes
`timedOutAttempts`. Initialization has its own `--init-timeout-ms` (default 60000).
Exceptions include flattened exception-group leaves and full tracebacks (close
tracebacks also go to stderr); per-step stdout JSON is compact with error text
truncated at 300 characters; application failures and close failures stay separate
in the final summary. Two-client evidence uses `lifetime-001/{A,B}.*` and a plain
summary table followed by JSON; monotonic absolute timestamps allow overlap and peer
ordering checks.

Exit codes: **0** every step passed and `CLOSE_OK`; **1** a step failed and close
succeeded; **3** close raised or hung; **2** usage or guard refusal. For multiple
lifetimes the precedence is 2, 3, 1, 0. A close result classifies transport
failures, cancel-scope misuse, server-gone, timeout or other exceptions, and an
earlier failure is never replaced by cleanup. Cancellation, KeyboardInterrupt and
SystemExit persist the attempt exception, stop remaining steps, record the
application failure once, then close and write a summary (a cancelled run with
`CLOSE_OK` exits 1). Deliberate mid-call cancellation remains a scenario.

`characterize_close.py` measures every ordering in a fresh child interpreter with a
hard timeout (default 30 s). A hang is `CLOSE_HANG`; it terminates that interpreter
by pid and kills only recorded spawn pids whose command line still contains the
absolute bundled fake-server path (unverified pids are skipped). It prints identity
plus a Markdown table, or machine JSON with `--json` (`--only` selects smoke
scenarios), exits 0 regardless of outcomes, annotates expected outcomes from the
same SDK-major table the tests use, and never rewrites measured outcomes to fit.
Evidence is under `scratch/pyharness/characterize-*` unless `--out-dir` is given.

The harness's own fake-server runs on Python 3.11.10, anyio 4.15.1 and pydantic
2.14.1 measured these outcomes with mcp 2.3.0 and 1.30.0. The table is regenerated
with `characterize_close.py`; `CLOSE_RAISED` describes context cleanup separately
from application errors. `notification-spam-then-close` on 1.x is timing
dependent: a slow notification interval sometimes closes cleanly.

| Ordering                           | mcp 2.3.0 outcome | mcp 1.30.0 outcome | leaf classes on 1.30.0                                       | Avoidable by |
| ---------------------------------- | ----------------- | ------------------ | ------------------------------------------------------------ | ------------ |
| normal                             | CLOSE_OK          | CLOSE_OK           | —                                                            | none needed  |
| server-exits-then-idle-close       | CLOSE_OK          | CLOSE_OK           | —                                                            | none needed  |
| server-exits-then-call             | CLOSE_OK          | CLOSE_OK           | —                                                            | none needed  |
| server-exits-during-call           | CLOSE_OK          | CLOSE_OK           | —                                                            | none needed  |
| mid-call-cancel                    | CLOSE_OK          | CLOSE_OK           | —                                                            | none needed  |
| mid-call-leave-contexts            | CLOSE_OK          | CLOSE_OK           | —                                                            | none needed  |
| sigterm-then-close                 | CLOSE_OK          | CLOSE_OK           | —                                                            | none needed  |
| sigkill-then-close                 | CLOSE_OK          | CLOSE_OK           | —                                                            | none needed  |
| server-closes-stdout-then-close    | CLOSE_OK          | CLOSE_OK           | —                                                            | none needed  |
| server-ignores-stdin-eof           | CLOSE_OK          | CLOSE_OK           | —                                                            | server       |
| server-ignores-eof-and-sigterm     | CLOSE_OK          | CLOSE_OK           | —                                                            | server       |
| notification-spam-then-close       | CLOSE_OK          | CLOSE_RAISED       | anyio.BrokenResourceError                                    | SDK          |
| server-writes-after-stdin-eof      | CLOSE_OK          | CLOSE_RAISED       | anyio.BrokenResourceError                                    | server       |
| late-response-after-leave          | CLOSE_OK          | CLOSE_RAISED       | anyio.BrokenResourceError                                    | SDK          |
| session-closed-transport-open-spam | CLOSE_OK          | CLOSE_RAISED       | asyncio.exceptions.CancelledError, anyio.BrokenResourceError | SDK          |
| two-clients-own-tasks              | CLOSE_OK          | CLOSE_OK           | —                                                            | none needed  |
| two-clients-exit-stack-non-lifo    | CLOSE_RAISED      | CLOSE_RAISED       | builtins.RuntimeError                                        | client       |
| close-in-other-task                | CLOSE_HANG        | CLOSE_RAISED       | builtins.RuntimeError                                        | client       |
| earlier-application-exception      | CLOSE_OK          | CLOSE_OK           | —                                                            | none needed  |
| caller-cancellation                | CLOSE_OK          | CLOSE_OK           | —                                                            | none needed  |

In 1.x, after the session closes its read stream, any further stdout line makes the
transport reader send into a stream with no receiver. That raises
`anyio.BrokenResourceError`; 1.x catches only `ClosedResourceError`, so its task
group fails and transport exit raises an exception group. 2.x catches both. The
trigger is any stdout write between session closure and transport process reaping. A
correct client keeps contexts in one task and closes them LIFO. For the 1.x
transport bug, upgrade to 2.x or catch the exception group at `stdio_client` exit;
client ordering alone cannot fix a server's post-EOF writes.

Where auto-mobile's stdio server falls: #11951 introduced `OutputGatedTransport`
(`src/server/outputGatedTransport.ts`) to drop writes after the client closes, and
#12049 refines it. After stdin `end`/`close`/`error`, the server runs requests it
already received to completion and writes their results or errors, in direct
(`--no-proxy`) and proxy mode. Everything unsolicited is dropped (list-changed,
resource-updated, logging, progress even for a received request, and server-to-client
requests). The gate closes fully after the last answer's write settles, then normal
shutdown releases sessions and exits 0; idle EOF closes the gate synchronously.

Each call keeps its own deadline (120 s by default via
`AUTOMOBILE_DAEMON_TIMEOUT_MS`). The overall EOF answer wait is capped at
`MAX_CALLER_MCP_REQUEST_TIMEOUT_MS` (30 min), before the normal 9 s shutdown bound
and 100 ms finalization. At that bound the gate stays answers-only while shutdown
starts: the proxy aborts a remaining call and its typed "MCP proxy is closing" answer
is still written. A stdout error (EPIPE) closes the gate fully and starts shutdown
at once; SIGTERM/SIGINT also start shutdown immediately, including during the EOF
wait, with typed errors still written while the gate allows received answers. EOF
before broker session acquisition finishes still shuts down immediately and aborts
acquisition (#11173). `test/server/stdioClientGoneSilence.test.ts` pins these
orderings with fake streams; they have **not yet been observed against a live daemon**.

The remaining 1.x Python SDK race is a client closing while its **own request is
still in flight**: that response can land in its close window and raise
`anyio.BrokenResourceError` (the `late-response-after-leave` row; answering a
received request after EOF is intentional). A client closing idle gets `CLOSE_OK`;
unsolicited post-EOF output is dropped.

To confirm on devices, use the 1.30.0 venv (the line that raises) against a private
daemon built from the commit under test, two clients on two emulators, ten lifetimes
each, closing idle after their requests finish. Every `close` record must be
`CLOSE_OK`, each client's session must be gone from the daemon within about 2 s of
its close, and no stdio server process may remain:

```bash
B=/absolute/private/batch
PY="$(bash scripts/manual-test/python/setup-venv.sh --batch-dir "$B" --mcp-version 1.30.0)"
for ORDER in a-first simultaneous; do
  "$PY" scripts/manual-test/python/two_clients.py \
    --batch-dir "$B" --daemon 1 \
    --script scripts/manual-test/python/scripts/observe-then-close.json \
    --var-a platform=android --var-a deviceId=emulator-a \
    --var-b platform=android --var-b deviceId=emulator-b \
    --out-dir "$B/python-pair-1x-$ORDER" --lifetimes 10 --close-order "$ORDER" \
    --stagger-ms 200 --close-mode-a normal --close-mode-b normal
done
```

A piped one-shot run must print both answers and exit 0, in proxy mode and direct
mode (`--no-proxy`), using the server built from the commit under test:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"one-shot","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"listDevices","arguments":{}}}' \
  | "$B/bin/am1" bun "$PWD/dist/src/index.js"
printf 'exit=%s\n' "$?"
```

The single-client `--close-mode mid-call` check on the 1.30.0 venv can still raise
`anyio.BrokenResourceError` when its own answer reaches the close window; it is not
an idle-close confirmation.

The Python check uses python3 >=3.11, falling back to a uv-managed interpreter, and
runs when `scripts/manual-test/python/` or the validator changes (path-selected in
`scripts/prepush-shell.sh`) and locally via `bash scripts/all_fast_validate_checks.sh --only manual-test-python`.
