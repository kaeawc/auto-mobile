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
`start`; the wrapper refuses all `daemon start*` and `daemon restart*` shorthands.
Use `env --batch-dir "$B" --daemon 1` to print the env file path, or source
`"$B/daemon1/env.sh"` before using `frame`/`aux` CLIs directly.

Every client requires all initialized private path variables and refuses host
defaults, canonical path aliases and resident socket/PID/lock basenames. Inherited
legacy `AUTO_MOBILE_*`, DB-file and WebRTC-socket overrides are stripped.

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
`up` and `serve` require a valid private daemon PID file naming a live process.
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

## Python MCP SDK stdio clients

<!-- Language exception: the TypeScript-only rule applies to application code. This manual-test tooling uses Python because Python anyio/mcp context-close failures cannot be reproduced by a TypeScript client. -->

Use `scripts/manual-test/python/` to retain every request and full response while
reproducing #11951 (stdio close) and #11950 (multiline typing). This tooling uses
the official Python `mcp` SDK, locked to 2.3.0. The existing TypeScript
`proxy-session.ts` and `@modelcontextprotocol/sdk` cannot reproduce Python/anyio
close-path errors; Python's standard library has no MCP client. The official SDK
is the thing under test. Tests use `unittest`, as the existing repository Python
tests do, rather than adding pytest. The only third-party imports are `mcp` and
its existing dependency `anyio`. No `claude-agent-sdk` or LLM loop is needed for
these scripted transport, close and typing behaviours.

Initialize and start a private daemon with the commands above first. The Python
client resolves its launch through `in-daemon-env.sh` and `harness-guard.ts`; the
TypeScript guard owns all private namespace rules and requires a live daemon pid
file. The proxy receives only the server entry point, with no daemon startup
flags. Both real and fake modes check every device-start call, including
`afterPeerClosed`, before spawning. Selector-only starts need `--allow-selector`.
There is no arbitrary command, socket, port or real-server environment override.

Set up Python 3.11+ inside an existing absolute batch directory. The setup script
never creates the batch directory, defaults to no batch, never deletes a venv,
and prints just the interpreter path on stdout. Its optional version override
installs after the hashed lock and reports **UNLOCKED** on stderr; use it only
for comparing SDK lines. The 1.30.0 line reproduces the transport failure.

```bash
B=/absolute/private/batch
PY="$(bash scripts/manual-test/python/setup-venv.sh --batch-dir "$B")"
# Optional comparison (reuses this batch's venv):
PY="$(bash scripts/manual-test/python/setup-venv.sh --batch-dir "$B" --mcp-version 1.30.0)"
printf '%s\n' "$PY"
```

The single-client modes all run the script first, except `mid-call`, which starts
the last call/read without awaiting it and leaves the contexts after the delay.
`normal` simply leaves the contexts. `after-server-exit` closes the captured
child's stdin and waits for exit. `sigterm-server` and `kill-server` signal only
that captured child, then wait. `--server-exit-wait-ms 0` races the signal with
context close. A failed process capture refuses modes needing a process handle
before any step; no pid is guessed. SDK contexts always close in their owning
task. Close deadlines kill only the captured child and report `CLOSE_HANG`.

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

For two emulators sharing one private daemon, each stdio server belongs to its
own asyncio task. Both initialize before traffic starts. With `a-first`, A closes
as soon as its steps finish while B continues; B runs `afterPeerClosed` after A's
close plus `--stagger-ms`. `b-first` mirrors this. `simultaneous` holds both at a
barrier and offsets B by the requested stagger. Repeat five lifetimes to retain
each close separately:

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

`observe-then-close.json` lists tools, observes the explicit device twice, reads
`automobile:devices/booted`, then idles briefly; its peer continuation observes
again. `sendkeys-multiline.json` requires an editor already focused on the device.
It records default multiline typing, repeated type commands in one call, clear
then type, explicit `mode: "ime"`, three character-at-a-time calls with retries,
and a final observation. Both scripts first call `startDevice` with required `platform` and explicit
`deviceId` variables. The stdio proxy binds the returned session and injects it
into later calls; observe and sendKeys omit `device` and `deviceId` to use that
binding. `device` is a plan label, not a device id. Retrying a typing error can duplicate text; inspect
the retained attempts. `--script-a` and `--script-b` can replace `--script` for
asymmetric traffic. Script keys and operations are strict; `${name}` substitution
uses `--var` (or `--var-a`/`--var-b`) in string values, including nested arguments.
Unknown keys, missing variables, non-object arguments and negative numbers
refuse before launch. `retries` means extra attempts, for exceptions or `isError`.

For a dry run, replace the real launch flags with `--fake-server`; optional
`--fake-env K=V` applies only to the bundled fake. It uses the installed SDK's
server API (FastMCP in 1.x, MCPServer in 2.x), implements scripted tools and the
`fake://status` resource, and bounds every fake to 60 seconds. `FAKE_ON_EOF`
accepts `exit` (default), `write-then-exit:20`, or `ignore`;
`FAKE_IGNORE_SIGTERM=1` adds the force-kill case.

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

The output directory is absolute and created with mode 0700. Reusing a directory
containing any named evidence file (or `lifetime-001` for two clients) is a usage
error before guard checks or spawn; use a new evidence directory. Evidence includes
`A.jsonl` (append-only, mode 0600, flush per record; fsync per record except
notifications, which fsync every 100 notification records and always on close),
`A.identity.json` (Python/platform/package versions, command/args, environment
**keys only**, close mode, script path and SHA256), and `A.server.stderr.log`.
JSONL writes `spawn-request` (command, args and environment keys) before launch
and `initialize-request` before initialization, retaining evidence even when
spawn fails (`exception` with `phase: "spawn"`). It retains spawn pid,
initialization, request before every attempt, full
`model_dump(mode="json", by_alias=True)` response or exception, notifications
when the SDK offers a handler, `server-request` method/params,
`transport-exception` details, server exit status/timing, and close. Step timeouts
bound only the wait: a timed-out attempt records `timedOut: true` and
`stillPending: true`, counts as failed, and may retry while its request continues.
The eventual full result is a `late-response` or `late-exception` with the same
index/attempt and `lateByMs`. After context exit pending requests get a bounded
three-second wait with `afterClose: true`; remaining tasks are cancelled and
recorded as `abandoned`. Summaries count `lateResponses` and `abandonedRequests`;
step stdout includes `timedOutAttempts`. Initialization has its own
`--init-timeout-ms` deadline (default 60000), independent of step timeouts. Exceptions
include flattened exception-group leaves and full tracebacks; close tracebacks
also go to stderr. Per-step stdout JSON is compact and truncates error text at
300 characters. Original step/application failures and close failures remain
separate in the final JSON summary. Two-client evidence uses
`lifetime-001/{A,B}.*` and a plain summary table followed by JSON. Monotonic
absolute timestamps allow overlap and peer ordering to be checked.

Exit codes: **0** means every step passed and `CLOSE_OK`; **1** means a step
failed and close succeeded; **3** means close raised or hung; **2** means usage or
guard refusal. For multiple lifetimes precedence is 2, then 3, then 1, then 0.
A close result classifies transport failures, cancel-scope misuse, server-gone,
timeout, or other exceptions. An earlier failure is never replaced by cleanup. Cancellation, KeyboardInterrupt
and SystemExit persist the attempt exception and stop the remaining steps,
record the application failure once, then close and write a summary; a cancelled
run with `CLOSE_OK` exits 1. Deliberate mid-call cancellation remains a scenario.

`characterize_close.py` measures every ordering in a fresh child interpreter,
with a hard timeout (default 30 seconds). A hang is `CLOSE_HANG`; it terminates
that interpreter by pid and kills only recorded spawn pids whose command line
still contains the absolute bundled fake-server path; unverified pids are skipped.
It prints identity plus a Markdown table, or machine JSON with `--json`;
`--only` selects smoke scenarios. It exits 0 regardless of measured close
outcomes. JSON annotates expected outcomes from the same SDK-major table used
by tests; measured outcomes are never rewritten to fit expectations. Evidence
is under `scratch/pyharness/characterize-*` unless `--out-dir` is supplied.

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

In 1.x, after the session closes its read stream, any further stdout line makes
the transport reader send into a stream with no receiver. That raises
`anyio.BrokenResourceError`; 1.x catches only `ClosedResourceError`, so its task
group fails and transport exit raises an exception group. 2.x catches both.
The trigger is any stdout write between session closure and transport process
reaping. A correct client keeps contexts in one task and closes them LIFO.
For the 1.x transport bug, upgrade to 2.x or catch the exception group at
`stdio_client` exit; client ordering alone cannot fix a server's post-EOF writes.

Where auto-mobile's proxy falls, from **code reading only** of origin/main on
2026-10-12, **not yet observed against a live daemon**: stdin EOF starts bounded
shutdown through `src/processLifecycle.ts` (`installStdinShutdownHandlers`) and
`src/shutdownCleanup.ts`. The stdio-proxy stage has a 2000 ms budget inside the
9000 ms process limit, then the process exits, so the proxy does not ignore EOF.
However, shutdown never closes the MCP Server/StdioServerTransport; stdout
remains writable until `process.exit`. This puts it in the post-EOF-write row
for 1.x Python clients. An in-flight tool/resource handler aborted by
`DaemonMcpProxy.closeOnce`/`untilClosed` returns a structured error which the SDK
writes within milliseconds of EOF (`src/daemon/daemonMcpProxy.ts`,
`src/server/proxyServer.ts` tools/call catch → `resolveCallToolErrorResult`).
While `closeOnce` awaits session releases (up to 1500 ms each), daemon
notifications can still be forwarded. `handleDaemonNotification`,
`notifyListChanged`, and `proxyServer.ts`'s `sendToolListChanged` have no closing
guard for tools/list_changed or resources/list_changed; this notification race
is plausible and needs a live run. resources/updated is suppressed because its
listeners are cleared synchronously.

A product fix, **not made here**, would stop stdout writes on EOF before any
awaited cleanup: close the MCP server/transport, or gate every send on a client
input-closed flag, then release sessions and exit. That makes the server safe
for every SDK line; a 1.x client cannot prevent the transport error by itself.

The Python check runs when `scripts/manual-test/python/` or the validator changes (path-selected in `scripts/prepush-shell.sh`) and locally via `bash scripts/all_fast_validate_checks.sh --only manual-test-python`.
