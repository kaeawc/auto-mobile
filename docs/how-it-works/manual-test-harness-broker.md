# Manual-test harness: broker scenarios, clients and evidence

Part of [the manual-test harness](manual-test-harness.md).

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

| Scenario                            | Class         | Expected evidence                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parallel-acquire`                  | device        | At least two clients within cap; distinct session/native identities, matching profiles, observe per client, release and absence.                                                                                                                                                                                                              |
| `capacity-refusal-and-replay`       | fake + device | Device batch needs capacity + 1 clients, where capacity is device ops `totalDeviceCap`; cap winners plus one retryable refusal (`retryRequires: "new_request_id"`) with no tools/grant; same refusal on replay after release; fresh attempt succeeds.                                                                                         |
| `release-destroy-verification`      | fake + device | Released receipt, cleanup complete, native absence, old session refused, fresh session/native identity. Fake proves only fake-native absence.                                                                                                                                                                                                 |
| `owner-death-and-abandon`           | fake + device | Fake: abandon pending/unknown/ready identities and join cleanup. Device: disposable-owner exit closes the proxy (its `closed.json` reason is the transport-local `proxy_exited_or_transport_closed`) and the broker's terminal receipt is `session_owner_exited`; ready abandonment yields `session_request_abandoned` and old proxy refusal. |
| `cross-client-isolation`            | fake          | Wrong-token status/release/rebind and generic lifecycle tools refused; legitimate client still observes. Use raw bound frames for live cross-client checks.                                                                                                                                                                                   |
| `daemon-restart-with-live-sessions` | device        | Graceful restart preserves session/native identities and observe. `--crash`: interrupted requests become terminal `session_owner_exited`, replay is identical, destruction precedes fresh successors.                                                                                                                                         |
| `#12451-restart-handoff`            | device        | Graceful restart handoff using the same restart assertions; no crash flag on this alias.                                                                                                                                                                                                                                                      |
| `#12452-retryable-prep-failure`     | fake          | Retryable `catalog_unavailable` replay is unchanged; unknown archetype fails validation; an absent exact Duo model is terminal `unsupported_hardware`.                                                                                                                                                                                        |
| `#12452-prep-timeout`               | device        | 1 ms preparation timeout is retryable (`timeout`, `daemon_unavailable` or `provision_failed`, whichever the deadline hits first) with settled cleanup; an absent exact Duo model is a nonretryable `unsupported_hardware` control.                                                                                                            |
| `#12491-pid-reuse-fencing`          | fake          | Reused PID/start identity refuses before allocation; matching identity acquires and releases.                                                                                                                                                                                                                                                 |
| `#12491-pid-reuse-positive-control` | device        | Recorded live disposable owner is accepted, then owner death closes proxy and destroys its device.                                                                                                                                                                                                                                            |

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

Where auto-mobile's stdio server falls: `OutputGatedTransport`
(`src/server/outputGatedTransport.ts`, #11951, #12049) drops writes after the client
closes. After stdin `end`/`close`/`error`, the server runs requests it
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
