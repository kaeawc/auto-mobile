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
- Device starts must name an explicit AVD name or simulator UDID/deviceId.
  Selector-only acquisition booted a protected AVD in batch 20261012a. The
  harness guards `startDevice`, `provisionDevice`, `getAndroid`, and `getApple`;
  `--allow-selector` deliberately bypasses that guard for a selection test.
- Never pass daemon flags to a stdio proxy: a startup-option mismatch can trigger
  a daemon restart. Set daemon flags only through `private-daemon.ts start`.
- Never rebuild `dist/` while a batch's daemons run. Build first, then start the
  batch from one explicit entry script.

## Initialize and run private daemons

Run these commands from the repository root after building the entry script.
Choose unused ports, an absolute evidence directory, and a short socket root.
The examples create a new batch; reuse its manifest for subsequent commands.

```bash
B="$PWD/scratch/manual-batch"
bun scripts/manual-test/private-daemon.ts init --batch-dir "$B" \
  --count 2 --base-port 3160 --aux-root /tmp/am-manual-batch \
  --server "$PWD/dist/src/index.js"
bun scripts/manual-test/private-daemon.ts start --batch-dir "$B" -- --debug
bun scripts/manual-test/private-daemon.ts status --batch-dir "$B"
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 daemon status
bun scripts/manual-test/private-daemon.ts stop --batch-dir "$B" --daemon 1
```

`init` writes `batch.json` and each `daemonN/env.sh` without starting a process.
`start` uses the current runtime and owns `--port` and `--strict-port`; it
refuses a recorded live PID. `status` reports the stored PID, port, socket and
env file. `stop` targets one manifest daemon. Restart means `stop` followed by
`start`; the wrapper's `daemon start` and `daemon restart` shorthands refuse.
Use `env --batch-dir "$B" --daemon 1` to print the env file path, or source
`"$B/daemon1/env.sh"` before using `frame`/`aux` CLIs directly.

Each daemon isolates its data, logs, database, coordination directory, auxiliary
sockets, control socket, PID, lock and launch log. The daemons still share the
host's adb server, AVD inventory and simulator set. By default the batch uses
**one shared adb-server coordination directory**: both boot admission and the
managed-slot registry live there. `init --split-adb-coordination` is only for
scenarios whose daemons must not see each other's coordination state. A split
registry made batch 20261012a report a false 7-of-6 capacity finding (#11905).
It does not create separate adb servers or make host capacity independent.

## Persistent stdio-proxy sessions

The wrapper's `proxy` shorthand runs `proxy-session.ts`. Use a new session
directory for every `up`. Paths resolve from your current working directory.
Omit `--config` for a plain proxy; supply a managed-slot config for a managed
execution. Managed acquisition is real and can create and boot a device.

```bash
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  proxy up --dir "$B/sessions/plain-1"
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  proxy call --dir "$B/sessions/plain-1" startDevice \
  '{"platform":"android","name":"manual-test-avd"}'
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
  frame send daemon/heartbeat '{"sessionId":"your-session-uuid"}'
```

Host/device mutation methods print a notice before sending. Restart and
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
at the given delay. Cancel modes end managed sessions through owner loss and
stop their heartbeat keeper. Cancellation exits 0 after the deliberate destroy,
without requiring responses. Send mode awaits every requested response.

## Auxiliary sockets and observer sessions

`aux` derives recording, video and WebRTC paths from the private aux directory.
The product's WebRTC resolver also supports its socket-path override; initialized
harness environments clear inherited overrides to keep all sockets private.
WebRTC requests reuse `sendWebRtcStreamRequest`.

Provide `--session-uuid` for an existing session, or `--observer` for a sessionless
viewer. Observer mode mints a UUID, registers it on the control socket, heartbeats
every 2000 ms by default, injects `sessionUuid`, and releases the observer on exit.
`--heartbeat-ms` must be below the returned heartbeat timeout. `--observer-name`
sets the registration's client name. An observer and an explicit session UUID
are mutually exclusive. Observers grant viewing admission, not device ownership;
see [Streams](device-ownership.md#streams-need-an-observer-registration-not-a-session)
and [Recordings](device-ownership.md#recordings) for control restrictions.

```bash
bash scripts/manual-test/in-daemon-env.sh --batch-dir "$B" --daemon 1 \
  aux recording status --observer
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
