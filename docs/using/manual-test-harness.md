# Manual-test harness

Use the harness for a manual batch that needs isolated daemons, persistent stdio
proxy executions, direct control frames, or recording and stream sockets. It
keeps the connection and evidence visible when testing ownership refusals,
managed-slot confinement, cancellation, and observer liveness.

Use `scripts/mcp-drive.ts` for a one-shot MCP plan. Use
[Live device acceptance](live-device-acceptance.md) for its signed, disposable
exact-device acceptance matrix. The harness does not replace that acceptance
protocol or its evidence assertions.

## Hard rules

- Never touch the resident daemon: its default socket, port 3000, or
  `~/.auto-mobile`. Run every client through `in-daemon-env.sh` or a harness CLI
  with the initialized private environment.
- Never use `pkill` or `killall`. Stop only daemons you started, using
  `private-daemon.ts stop` for that batch and daemon number.
- Never delete an AVD, simulator, or directory. Keep batch evidence and devices.
- For `startDevice`, use `avdName` (Android) or `deviceId` (UDID/serial);
  `name` alone is a matcher and is refused.
  Selector-only acquisition booted a protected AVD in batch 20261012a. The
  harness guards `startDevice`, `provisionDevice`, `getAndroid`, and `getApple`;
  `--allow-selector` deliberately bypasses that guard for a selection test.
- Never pass daemon flags to a stdio proxy: a startup-option mismatch can trigger
  a daemon restart. Record daemon flags with `init --daemon-arg`, or add one-off flags through
  `private-daemon.ts start --`.
- Never rebuild `dist/` while a batch's daemons run. Build first, then start the
  batch from one explicit entry script.

## Initialize and run private daemons

Run these commands from the repository root after building the entry script.
Choose unused ports, an absolute evidence directory, and a short socket root.
The examples create a new batch; reuse its manifest for subsequent commands.
When invoking harness commands from an agent tool call, redirect stdin with
`< /dev/null` so the tool cannot keep the invocation waiting on its input.

```bash
B="$PWD/scratch/manual-batch"
bun scripts/manual-test/private-daemon.ts init --batch-dir "$B" \
  --count 2 --base-port 3160 --aux-root /tmp/am-manual-batch \
  --server "$PWD/dist/src/index.js" \
  --daemon-arg --plan-execution-lock-scope --daemon-arg session \
  --daemon-arg --tool-call-recording \
  --env NOTE=batch --daemon-env 2:NOTE=second
bun scripts/manual-test/private-daemon.ts start --batch-dir "$B" -- --debug
bun scripts/manual-test/private-daemon.ts status --batch-dir "$B"
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 daemon status
bun scripts/manual-test/private-daemon.ts stop --batch-dir "$B" --daemon 1
```

`init` writes `batch.json`, each `daemonN/env.sh`, and executable generated
`bin/amN|proxyN|frameN|auxN` wrappers without starting a process. `amN daemon …`
uses the selected private daemon; `amN cli …` performs a one-shot product CLI
call with `--cli --port`. `proxyN`, `frameN` and `auxN` select that daemon's
harness client. `wrappers --batch-dir "$B"` regenerates the wrappers alone.

`--env K=V` is repeatable and applies to all daemons; `--daemon-env N:K=V`
overrides it for daemon N. `--daemon-arg TOKEN` records each daemon argv token;
`N:TOKEN` selects a daemon. For example, `--daemon-arg
--plan-execution-lock-scope --daemon-arg session --daemon-arg
--tool-call-recording` records both options. `--daemon-arg=--debug` is also
accepted. Restarts reuse recorded env and argv; `start -- …` adds one-off argv.
The harness owns `--port` and `--strict-port`.

`start` refuses a recorded live PID, then mirrors the daemon's JSON PID to
`daemonN/pid.txt`. `stop` targets one manifest daemon and removes `pid.txt` on
success; a failed stop preserves it. `status` reports JSON/plain PID agreement
(`pidTxt` is `ok`, `missing`, or `stale`), process liveness, socket response,
port and env file. `status --devices` appends host inventories and the daemon's
own view, with `daemonDevicesMethod: "daemon/availableDevices"`. Status is
read-only except for that method's inventory ownership/discovery refresh; it
boots or claims no device. ADB inventory is skipped when no local server is
listening. Each diagnostic failure is returned as evidence.

Restart means `stop` followed by `start`; wrappers refuse `daemon start*` and
`daemon restart*` shorthands. `env --batch-dir "$B" --daemon 1` prints an env
file path. `in-daemon-env.sh --cd /absolute/existing/dir` opts into changing cwd;
otherwise it preserves the caller's cwd. Its `cli` shorthand matches `amN cli`.

```bash
"$B/bin/am1" cli listDevices < /dev/null
"$B/bin/frame1" session-info your-session-uuid < /dev/null
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  --cd "$PWD" cli listDevices < /dev/null
bun scripts/manual-test/private-daemon.ts status --batch-dir "$B" --devices < /dev/null
bun scripts/manual-test/private-daemon.ts wrappers --batch-dir "$B" < /dev/null
```

Every client requires all initialized `state` variables and refuses host
defaults, canonical aliases and resident socket/PID/lock basenames. The audited
path policy is exhaustive for configurable product state destinations:

| Kind     | Variables                                                                                                                                                                  | Harness policy                                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `state`  | `AUTOMOBILE_DATA_DIR`, `AUTOMOBILE_LOG_DIR`, `AUTOMOBILE_DB_DIR`, `AUTOMOBILE_COORDINATION_DIR`                                                                            | Required per-daemon defaults under the evidence root.                                                                                                                                                              |
| `state`  | `AUTOMOBILE_ADB_SERVER_COORDINATION_DIR`                                                                                                                                   | Batch shared default, or per-daemon with `--split-adb-coordination`.                                                                                                                                               |
| `state`  | `AUTOMOBILE_AUX_SOCKET_DIR`, `AUTOMOBILE_DAEMON_SOCKET_PATH`                                                                                                               | Short auxiliary root and `d.sock`.                                                                                                                                                                                 |
| `state`  | `AUTOMOBILE_DAEMON_PID_FILE_PATH`, `AUTOMOBILE_DAEMON_LOCK_FILE_PATH`, `AUTOMOBILE_DAEMON_LAUNCH_LOG_PATH`                                                                 | Per-daemon PID, lock and launch log.                                                                                                                                                                               |
| `state`  | `AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR`, `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA`                                                                                            | Private path selection only; optional private overrides.                                                                                                                                                           |
| `opt-in` | `AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR`, `AUTOMOBILE_PLAN_HEALTH_DIR`, `AUTOMOBILE_TOOL_OUTPUTS_DIR`                                                                         | Unset by default; strip inherited values in both spellings. Explicit `--env`/`--daemon-env` requires an absolute private path. These enable exchange capture, plan health files/results, or tool-output artifacts. |
| `unset`  | `AUTOMOBILE_DB_PATH`, `AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH`                                                                                                               | Strip competing overrides in both spellings.                                                                                                                                                                       |
| `input`  | `AUTOMOBILE_CTRL_PROXY_APK_PATH`, `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH`, `AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH`, `AUTOMOBILE_CWEBP_PATH`, `AUTOMOBILE_DWEBP_PATH`          | Caller-selected read-only artifacts/executables; no harness defaults.                                                                                                                                              |
| `input`  | `AUTOMOBILE_DAEMON_LAUNCH_CWD`, `AUTOMOBILE_IOS_CODE_SIGN_ENTITLEMENTS_PATH`, `AUTOMOBILE_MIGRATIONS_DIR`, `AUTOMOBILE_NETWORK_FILTER_APP_PATH`, `AUTOMOBILE_PROJECT_ROOT` | Caller-selected working directory or build/signing inputs.                                                                                                                                                         |
| `input`  | `AUTOMOBILE_STARTUP_BENCHMARK_OUTPUT`, `AUTOMOBILE_UNIT_TEST_ISOLATED_DATA_DIR`                                                                                            | Explicit benchmark/test harness markers, not normal daemon state.                                                                                                                                                  |
| `input`  | `AUTOMOBILE_MANAGED_SLOT_CONFIG`                                                                                                                                           | Read-only config, stripped from inherited client environments; use explicit binding/config.                                                                                                                        |
| `input`  | `AUTOMOBILE_FFMPEG`, `AUTOMOBILE_IOS_WEBRTC_FFMPEG`, `AUTOMOBILE_VIDEO_SERVER_JAR`, `AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER`, `AUTOMOBILE_IOS_PROTOTYPE_AGENT`               | Caller-selected read-only encoder/helper inputs.                                                                                                                                                                   |

Legacy `AUTO_MOBILE_*` values are stripped. `env.sh` explicitly unsets opt-ins
unless configured, so sourcing it cannot silently enable them. Clients validate
opt-in paths only when supplied and discard inherited opt-ins; daemon manifest
overrides are retained on launch. `scripts/manual-test/productPathEnv.ts` is the
registry, checked against product env reads. Harness entry scripts select the
stderr log sink before product imports only when no explicit sink or private
log dir is supplied; child environments undo that harness-only selection so
private daemons continue logging to their private files.

Control sockets live under the short aux root, normally
`/tmp/am-mt-<hash>/<N>/d.sock`, **not under the batch directory**. Each daemon
isolates data, logs, database, coordination, auxiliary sockets, control socket,
PID, lock, launch log and iOS cache/build paths.

Known uncovered product path: the libwebp cache has no environment override
(`src/utils/image/webp/WebpBinaryResolver.ts:94`). A private daemon that needs to
download libwebp would write to `~/.auto-mobile/libwebp`. Supply
`AUTOMOBILE_CWEBP_PATH` and `AUTOMOBILE_DWEBP_PATH` to avoid that download/cache.

The daemons still share the
host's adb server, AVD inventory and simulator set. By default the batch uses
**one shared adb-server coordination directory**: both boot admission and the
managed-slot registry live there. `init --split-adb-coordination` is only for
scenarios whose daemons must not see each other's coordination state. A split
registry made batch 20261012a report a false 7-of-6 capacity finding (#11905).
It does not create separate adb servers or make host capacity independent.

## Persistent stdio-proxy sessions

The wrapper's `proxy` shorthand runs `proxy-session.ts`. Use a new session
directory for every `up`. Paths resolve from your current working directory.
`up` and `serve` require a valid private daemon PID file naming a live process
**and a responding control socket**, probed with read-only `daemon/capabilities`.
A recycled PID cannot pass the socket precheck. `status` reports
`daemonSocketAlive` alongside proxy/driver liveness.
Run `private-daemon.ts start` first; never launch a proxy to wake a dead daemon.

Omit `--config` for a plain proxy; supply a managed-slot config for a managed
execution. Managed acquisition is real and can create and boot a device.

```bash
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  proxy up --dir "$B/sessions/plain-1"
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  proxy call --dir "$B/sessions/plain-1" startDevice \
  '{"platform":"android","avdName":"manual-test-avd"}'
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  proxy tools --dir "$B/sessions/plain-1"
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  proxy resources --dir "$B/sessions/plain-1"
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  proxy read --dir "$B/sessions/plain-1" automobile:devices/booted
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  proxy subscribe --dir "$B/sessions/plain-1" automobile:devices/booted
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  proxy status --dir "$B/sessions/plain-1"
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  proxy close --dir "$B/sessions/plain-1"
```

`call` accepts inline JSON or `@file.json`, `--timeout-ms`, `--full`, and the
deliberate `--allow-selector` override. `up --config configs/slot.json` uses
one proxy for the config's execution. The driver remains its parent and owner.
The session directory contains `init.json`, `driver.pid`, `proxy.pid`,
`proxy.stderr.log`, `serve.log`, `events.jsonl`, `notifications.jsonl`, `in/`,
`out/<id>.json`, and eventually `closed.json`. Full responses stay in `out/`;
stderr identifies the response file. Subscriptions write notifications to
`notifications.jsonl`.

There are three execution endings to observe, as documented in
[Managed slots](managed-slots.md#lifecycle) and
[Device ownership](device-ownership.md#when-a-session-is-released):

- **Clean close:** `proxy close` closes MCP/stdin and triggers bounded
  `daemon/releaseExecution` for managed sessions.
- **Proxy exit:** graceful shutdown releases sessions; abrupt transport loss
  falls back to the owner's no-heartbeat window (about 10 seconds).
- **Owner loss:** the proxy detects loss of its execution owner and shuts down,
  releasing sessions. Only simulate this on processes your batch started.

Managed release retains the slot's device assignment. Heartbeats and reads do
not extend the managed idle window; release does not delete the device.

## Raw daemon frames

`frame send` writes newline-delimited JSON directly, without the product client's
handshake, reconnection, hidden IDs or automatic binding. It prints every received
line in full with an elapsed-millisecond prefix. `daemon/*`, `ide/*` and
`input/*` default to `daemon_request`; `tools/call` defaults to `mcp_request`.
Use `--type` to override that for protocol tests.

```bash
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  frame send daemon/refreshDevices '{}' --count 2 --timeout-ms 30000
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  frame send input/tap '@scratch/tap-params.json' --mode cancel-after:100
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  frame heartbeat your-session-uuid
```

`frame session-info <sessionId>` sends `daemon/sessionInfo`; `frame heartbeat
<sessionId>` sends the external one-shot CLI keeper fields without an ownership
claim. A heartbeat for a proxy-owned session is rejected by the daemon and
changes nothing. Both accept common socket/count/deadline flags. A known
kebab-case method prints a "did you mean" hint and still sends the requested
method, so protocol refusals remain observable.

Host/device mutation methods print a notice before sending. `daemon/refreshDevices`
prints an inventory refresh notice: no device is booted or claimed. Read routes
such as `sessionInfo`, `capabilities` and `ide/status` print no mutation notice. Restart and
maintenance methods additionally require `--allow-host-mutation`, because they
can disrupt other agents using the private daemon. A typed refusal is printed
in full and exits 1. `--socket` must remain absolute and private.

An external client cannot send on a live proxy's socket. Instead,
`--managed-binding configs/slot.json` uses the proxy's acquisition helper on
**this client's single connection**, claims and heartbeats each returned session,
then sends the requested frames on that same connection. This tests managed
connection confinement (#11770). It **acquires the config's slots for real** and
can create and boot its `amslot-*` device. Use a runner namespace no live proxy
is using; do not borrow another execution's config. Inline config JSON is also
accepted. A failed daemon acquisition still sends the user frames so the empty
managed binding's refusals can be observed; exit status reflects those frames.

```bash
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  frame send ide/status '{}' --managed-binding configs/manual-slot.json --hold-ms 5000
```

`--hold-ms` defaults to 0, then held sessions are released with the proxy's
owner token and bounded `releaseExecution` request. `--mode cancel` writes all
frames and immediately destroys the socket; `cancel-after:<ms>` destroys it
at the given delay. These destroy modes end managed sessions through owner loss and
stop their heartbeat keeper. Cancellation exits 0 after the deliberate destroy,
without requiring responses. Send mode awaits every requested response.

`--mode cancel-keep-open[:<ms>]` writes the frames, waits `--cancel-after-ms`
(default 0), then sends the product's same-connection `daemon/cancelRequest`
with each request ID. It keeps reading until every original ID has an answer or
the read window (default 5000 ms) expires, prints timestamped answers and a final
`{"cancelled":[{"id":"…","answered":true,"success":false,"code":"…"}]}` summary,
then ends the connection gracefully. Missing answers have `answered:false`.
Exit 0 means cancellation ran; exit 3 means connection failure.

Repeatable `--then '<method> <params json|@file>'` sends frames sequentially after
the initial answers on the same connection (send mode only). Every frame has
the same device-start guard, mutation notice and host-mutation gate. JSON string
values accept `{{ownSessionId}}` (first acquired session),
`{{ownSessionId:<slotIndex>}}` (the specified slot), and
`{{ownLivenessOwnerToken}}` (the keeper's token). Missing bindings or unresolved
placeholders refuse with exit 2 before user frames are sent. Invalid slot indices
are caught before acquisition. Automatic release accepts typed missing-session
or successful `alreadyReleased:true` responses as completed. Send mode exits 0
only when every frame succeeds, otherwise 1 (3 for timeout/connection).

```bash
"$B/bin/frame1" send tools/call @scratch/params.json \
  --mode cancel-keep-open:5000 --cancel-after-ms 100 < /dev/null
"$B/bin/frame1" send ide/status '{}' --managed-binding configs/manual-slot.json \
  --then 'daemon/sessionInfo {"sessionId":"{{ownSessionId}}"}' \
  --then 'daemon/releaseExecution {"sessionId":"{{ownSessionId}}","livenessOwnerToken":"{{ownLivenessOwnerToken}}"}' < /dev/null
```

## Auxiliary sockets and observer sessions

`aux` derives recording, video and WebRTC paths from the private aux directory.
The product's WebRTC resolver also supports its socket-path override; initialized
harness environments clear inherited overrides to keep all sockets private.
WebRTC requests reuse `sendWebRtcStreamRequest`.

Recording `start`, `stop` and `status` require `--session-uuid`: a device session
(the owner for start/stop; any live device session may read status). A retained
stop result can still be fetched with its former owner's UUID. Get `sessionUuid`
from the proxy's tool response or managed slots printed by `proxy up`/`status`,
or from `amN daemon active-sessions --json`. Recording refuses `--observer` at
parse time. The socket is `device-gesture-recording.sock`; the tools are
`recordToolCalls` and `recordDeviceGestures`, with daemon flag
`--tool-call-recording`.

For video/WebRTC, provide `--session-uuid` for an existing session, or `--observer`
for a sessionless viewer. Observer mode mints a UUID, registers it on the control socket, heartbeats
every 2000 ms by default, injects `sessionUuid`, and releases the observer on exit.
`--heartbeat-ms` must be below the returned heartbeat timeout. `--observer-name`
sets the registration's client name. An observer and an explicit session UUID
are mutually exclusive. Observers grant viewing admission, not device ownership;
see [Streams](device-ownership.md#streams-need-an-observer-registration-not-a-session)
and [Recordings](device-ownership.md#recordings) for control restrictions.

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
counts bytes after that line for `--hold-ms` (default 5000), or until the server
closes, and prints `{ack, bytesAfterAck, closedBy}`. Binary newlines are counted
as bytes. The product exports no packet decoder, so the harness does not infer
packet counts or subscription notices from binary data. WebRTC prints the full
response; `start` requires `whipEndpoint` in the JSON. Other actions are `stop`,
`status`, `list`, and `await`.

Frame and aux exit codes are 0 for success, 1 for a typed refusal, 2 for usage or
a private-environment/device-start guard, and 3 for timeout or connection failure.
Private-daemon and proxy commands retain their own exit codes; inspect their
full evidence rather than treating exit 0 as device-side proof.

All three client CLIs support `--help`, `-h`, `help` and `<subcommand> --help`
on stdout with exit 0. Their help lists every accepted command/flag, defaults,
examples and exit codes. Parse errors go to stderr with a `--help` pointer and
exit 2. Private-daemon exits 0 on success/status, 2 on usage/guard/I/O failures,
and propagates the product lifecycle command's exit code. Proxy exits 0 on
success/status, 1 on a failed/refused response, 2 on usage/guard/wait deadline,
3 when serve loses its transport and 4 when serve initialization fails.
