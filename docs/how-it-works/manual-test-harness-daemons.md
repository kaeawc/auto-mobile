# Manual-test harness: daemons and boots

Part of [the manual-test harness](manual-test-harness.md).

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
harness uses the product parsers; see [Session requirements](../how-it-works/session-requirements.md)
and the [session broker operator/consumer contract](../how-it-works/session-broker-experiment.md).

The batch also carries the product's catalog classification keys. The host-config
parser validates them and the harness copies them into `broker/host-config.json`:
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
test refusals). The `capacity_exhausted` refusal reports `retryable: true` with
`retryRequires: "new_request_id"`: replaying the same request ID returns the
identical stored refusal, so a retry needs a fresh ID. The acquisition deadline is
26 minutes including the boot gate; a timeout signals no process. Inspect `status`,
then `down` before another batch. The `down` command closes clients in reverse start order,
waits for receipts and verifies native absence (240 s budget). The `report` command writes
`evidence/broker-report.json` (outcomes, timings, ledger data).

`--env K=V` is repeatable for all daemons; `--daemon-env N:K=V` overrides per
daemon. `--daemon-arg TOKEN` records each daemon argv token (`N:TOKEN` selects a
daemon; `--daemon-arg=--debug` also works). Restarts reuse recorded env and argv;
`start -- …` adds one-off argv. The harness owns `--port` and `--strict-port`.
`init` records `AUTOMOBILE_PROJECT_ROOT` as the harness checkout, so local runner
source builds find `ios/control-proxy`; `--env`/`--daemon-env` override it.

`start` refuses a recorded live PID, then mirrors the daemon's JSON PID to
`daemonN/pid.txt`. The `stop` command confirms identity through `ide/status` on the
private control socket, sends SIGTERM to the recorded PID, and waits up to `--wait-ms`
(default 30000). It prints one JSON line with `outcome` (`stopped`, `still-alive`,
`gone-before-signal`) and `via` (`signal`, `product-cli`, `none`). When identity is
not confirmed it delegates to the product CLI (`amN daemon stop` remains the product
stop path). It never escalates to SIGKILL; exit 1 means `still-alive` and preserves
`pid.txt`, success removes it. A `stop --wait-ms 0` signals and reports `still-alive`
unless the daemon is already gone.

For the explicit crash-recovery test only: `private-daemon.ts stop --batch-dir "$B"
--daemon 1 --crash` sends SIGKILL only to this batch's recorded daemon PID. It first
confirms PID, socket and PID file through `ide/status`, matching
`daemon-start.json`, and re-checks the recorded process start identity right
before signalling. It never delegates, signals children or process groups, or kills
by name; missing or mismatched identity refuses. Success reports `crashed`.

`status` reports JSON/plain PID agreement (`pidTxt`: `ok`, `missing`, `stale`),
liveness, socket response, port and env file. The `status --devices` form appends host
inventories and the daemon's own view (`daemonDevicesMethod:
"daemon/availableDevices"`). It is read-only apart from that method's inventory
ownership/discovery refresh and boots or claims no device. Android inventory reads
`host:devices-l` over the local ADB server socket without launching `adb` (it skips this
when no server listens). Each diagnostic failure comes back as evidence.

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

| Kind     | Variables                                                                                                                                                                                              | Harness policy                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`  | `AUTOMOBILE_DATA_DIR`, `AUTOMOBILE_LOG_DIR`, `AUTOMOBILE_DB_DIR`, `AUTOMOBILE_COORDINATION_DIR`                                                                                                        | Required per-daemon defaults under the evidence root.                                                                                                                                                                                                             |
| `state`  | `AUTOMOBILE_ADB_SERVER_COORDINATION_DIR`                                                                                                                                                               | Batch shared default, or per-daemon with `--split-adb-coordination`.                                                                                                                                                                                              |
| `state`  | `AUTOMOBILE_AUX_SOCKET_DIR`, `AUTOMOBILE_DAEMON_SOCKET_PATH`                                                                                                                                           | Short auxiliary root and `d.sock`.                                                                                                                                                                                                                                |
| `state`  | `AUTOMOBILE_DAEMON_PID_FILE_PATH`, `AUTOMOBILE_DAEMON_LOCK_FILE_PATH`, `AUTOMOBILE_DAEMON_TOKEN_FILE_PATH`, `AUTOMOBILE_DAEMON_LAUNCH_LOG_PATH`                                                        | Per-daemon PID, lock and launch log.                                                                                                                                                                                                                              |
| `state`  | `AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR`, `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA`                                                                                                                        | Private path selection only; optional private overrides.                                                                                                                                                                                                          |
| `opt-in` | `AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR`, `AUTOMOBILE_PLAN_HEALTH_DIR`, `AUTOMOBILE_TOOL_OUTPUTS_DIR`, `AUTOMOBILE_STARTUP_BENCHMARK_OUTPUT`                                                              | Unset by default; strip inherited values in both spellings. Explicit `--env`/`--daemon-env` requires an absolute private path. These enable exchange capture, plan health files/results, tool-output artifacts, or benchmark output when benchmarking is enabled. |
| `unset`  | `AUTOMOBILE_DB_PATH`, `AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH`                                                                                                                                           | Strip competing overrides in both spellings.                                                                                                                                                                                                                      |
| `input`  | `AUTOMOBILE_CTRL_PROXY_APK_PATH`, `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH`, `AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH`, `AUTOMOBILE_WATCH_RUNNER_XCTESTRUN`, `AUTOMOBILE_CWEBP_PATH`, `AUTOMOBILE_DWEBP_PATH` | Caller-selected read-only artifacts/executables; no harness defaults.                                                                                                                                                                                             |
| `input`  | `AUTOMOBILE_DAEMON_LAUNCH_CWD`, `AUTOMOBILE_IOS_CODE_SIGN_ENTITLEMENTS_PATH`, `AUTOMOBILE_MIGRATIONS_DIR`, `AUTOMOBILE_NETWORK_FILTER_APP_PATH`, `AUTOMOBILE_PROJECT_ROOT`                             | Caller-selected working directory or build/signing inputs.                                                                                                                                                                                                        |
| `input`  | `AUTOMOBILE_UNIT_TEST_ISOLATED_DATA_DIR`                                                                                                                                                               | Test preload isolation marker, not a state destination.                                                                                                                                                                                                           |
| `input`  | `AUTOMOBILE_SESSION_BROKER_CONFIG`, `AUTOMOBILE_SESSION_CONFIG`                                                                                                                                        | Harness-owned: inherited values stripped; forbidden in `--env`/`--daemon-env`. Host config is set only on broker daemon 1 start; client requests use `--client`.                                                                                                  |
| `input`  | `AUTOMOBILE_FFMPEG`, `AUTOMOBILE_VIDEO_SERVER_JAR`, `AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER`, `AUTOMOBILE_IOS_PROTOTYPE_AGENT`                                                                           | Caller-selected read-only encoder/helper inputs.                                                                                                                                                                                                                  |

Legacy managed-slot configuration and `AUTO_MOBILE_*` values are stripped. `env.sh`
unsets opt-ins unless configured, so sourcing it cannot silently enable them.
Clients validate opt-in paths only when supplied and discard inherited opt-ins;
daemon manifest overrides are retained on launch.
The registry is `scripts/manual-test/productPathEnv.ts`, checked exhaustively
against product env reads with its sorted non-path list. Harness entry scripts
preserve explicit `stderr` sinks. File logging before product imports requires an
explicit absolute log directory outside both home defaults, checked lexically and
through existing ancestors' realpaths. All other cases (invalid sink values,
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
The `init --split-adb-coordination` option is only for scenarios whose daemons must not see
each other's coordination state (a split registry can report false capacity
findings, #11905); it creates no separate adb servers.

## Host preflight and staggered boots

`preflight --batch-dir "$B" [--strict]` reports platform, power source and charge,
system-wide sleep assertions, lid state and clamshell sleep. It also reports low-power
mode (from `lowpowermode` or `powermode`; absence of both is not a warning), the three
load averages, CPU count and free/total memory bytes. On macOS it reads `pmset -g batt`,
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
on wake, so timings across a sleep are invalid (#12212); discard timings measured
during a host load spike too.

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
