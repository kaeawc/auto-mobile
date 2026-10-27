# Elicitation for an ambiguous device target

Spike for [#13945](https://github.com/kaeawc/auto-mobile/issues/13945): one flow (an
`ambiguous_device_target` refusal) may ask a supervising client which device to use. Confirmations
(`killDevice`, `uninstallApp`, data wipe) and the other candidate flows are out of scope until the
measurement below says otherwise.

## Contract

- A tool result that is the typed `ambiguous_device_target` refusal with two or more distinct
  candidates, on a call that names no `deviceId`, is intercepted by the shared `tools/call`
  envelope (`installToolCallDispatcher`).
- If the client declared form elicitation, the server asks once with `elicitation/create`
  with a single-select enum: `deviceId`, one `oneOf` entry per candidate, titled
  `<deviceId> (<platform>)`.
- `accept` naming an offered device re-runs the call once with that `deviceId`. Anything else
  returns the original refusal byte for byte: decline, cancel, a device that was not offered, a
  failed ask, a cancelled call, or no answer within `AMBIGUOUS_DEVICE_ELICITATION_TIMEOUT_MS`
  (20 s, on the injected `Timer`).
- The refusal wire contract (`test/fixtures/refusal-wire/ambiguous_device_target.json`) does not
  change; the wrapper reads it, so every raise site (`executionTarget`, `readTarget`,
  `ReadinessSelection`) is covered without edits.

## Capability and topology

- Legacy capability is read per connection from the server instance that owns the client's `initialize`
  (`getClientCapabilities()`), never cached. `elicitation.form`, or a bare `elicitation: {}`, counts;
  a URL-only declaration does not.
- Legacy requests ask over a stateful client connection: the stdio proxy and direct stdio server.
  A legacy daemon HTTP request has no push channel; its proxy asks the client instead.
- Modern (2026-07-28) requests declare capabilities in their request envelope and ask through MRTR:
  `input_required` embeds the device question as `inputRequests.deviceChoice` and an SDK
  HMAC-SHA256 `requestState`. A retry echoes that state alongside `inputResponses.deviceChoice`.
  The versioned state binds the tool name, SHA-256 of arguments serialized with canonical key
  order (excluding only the top-level `deviceId`), and the offered device IDs. It expires after
  ten minutes, checked with the injected clock as well as the SDK's wall-clock expiry.
- The SDK verifies modern state before dispatch and exposes only the verified payload to the
  wrapper. The selected device must belong to both the signed offered list and the backend's
  freshly computed candidates, and the tool and argument hash must match. Missing or mismatched
  state, or a declined, cancelled, invalid or empty response map returns the original refusal
  unchanged and never asks again. Tampered, malformed, expired or session-mismatched wire state
  is rejected by the SDK with `-32602`, `Invalid or expired requestState`, and
  `data.reason: "invalid_request_state"`, before the tool executes.
- A lazy per-process 256-bit secret survives the daemon's per-request server construction;
  a daemon restart invalidates outstanding state. The SDK's `bind` tag uses the request header's
  MCP session key through the shared session-key reader. State from a keyed caller cannot be
  used under a different or absent key. Requests without a session-key header share an unkeyed
  binding; callers must supply a stable key for caller isolation. The state is signed, not
  encrypted, and contains no secret or raw session key. Legacy elicitation is unchanged.

## Switch and decline memory

- `AUTOMOBILE_ELICITATION=off` (`src/server/elicitationPolicy.ts`, read per call) disables the
  question in every era: the legacy wrapper, the MRTR wrapper and the task path return the refusal
  without asking. The refusal is recorded with outcome `disabled`.
- A legacy connection remembers a `decline` or `cancel` per candidate set (sorted, de-duplicated
  device ids) in a `DeclineMemory` created once per `installToolCallDispatcher`, i.e. per stateful
  client connection; the next identical ambiguity is recorded as `remembered` and not asked. `accept`,
  `timeout`, `invalid` and `error` are not remembered, and a different set asks again. Modern requests
  are stateless and remember nothing.

## Why it cannot stall an unattended call

Headless agents are most traffic and rarely declare elicitation, so they take the unchanged path. A
legacy harness that declares it but has nobody to answer is bounded by the timer, which aborts the request
(the SDK sends `notifications/cancelled`) and returns the refusal. The retry passes `deviceId`, so it
cannot ask twice. Modern requests return the question immediately without waiting on a timer; any
retry response map ends the question flow, and a valid selection runs the backend once more.

## Measuring before extending

Extending to confirmations needs data on which clients declare elicitation and how asks end. Every
ambiguous-device refusal on a call without `deviceId` produces one `ElicitationRecord`
(`src/server/elicitationOutcome.ts`):

- `declared`: `none`, `bare` (`elicitation: {}`), `form` or `url`, read per connection (legacy) or from
  the request envelope (modern).
- `era`: `legacy` push or `modern` MRTR/task.
- `outcome`: `not_offered` (client cannot be asked: the denominator for the rest), `asked` (modern
  question handed back; the answer arrives on a later request), then `accept`, `decline`, `cancel`,
  `timeout` (legacy only), `invalid` (accepted an unoffered device, malformed or missing answer) or
  `error` (the ask itself failed).
- `latencyMs`: ask to answer on the injected timer, for legacy asks and modern answers; absent for
  `not_offered` and `asked`.

Every process logs one `[elicitation] ...` info line per record. The server composition root
(`src/server/index.ts`) also registers a recorder that pushes a push-only `elicitation` telemetry event;
the stdio proxy has no telemetry sink and logs only. The `ElicitationRecorder` is injectable
(`ambiguousDeviceElicitation.recorder` for the legacy path, an argument to `withAmbiguousDeviceMrtr`),
so tests assert records with a fake.

### Real-client conformance

`test/server/claudeCodeElicitation.integration.test.ts` drives a real Claude Code (at least 2.1.311, named by
`AUTOMOBILE_CLAUDE_BIN`; skipped without one, and a `claude` on PATH is never spawned) with a loopback stand-in for the
Anthropic API against a stdio stub built on the production dispatcher. It runs in the advisory nightly
job `claude-code-elicitation-conformance` against a pinned binary and never touches a device. Measured
against 2.1.311: headless `-p` declares `elicitation: {form, url}` on `initialize` and answers the
legacy question with `cancel`, so the call ends with the typed refusal. A stub that serves the
modern era over stdio but does not answer `server/discover` is treated as a legacy peer: capabilities
arrive on `initialize`, no request envelope is sent, and the modern wrapper records `not_offered`. The test
branches on the envelope so it also covers Claude Code taking the 2026-07-28 path when it does.

### MRTR limits (modern era)

- A modern tool call that runs as a task returns its task handle immediately. Inside the task's
  work, an ambiguity refusal pauses it in `input_required`; `tasks/get` inlines the question as
  `inputRequests.deviceChoice`, and only the creating session's owner key may answer through
  `tasks/update`. The original request envelope must declare form elicitation, and the call
  must omit `deviceId`. The same accepted-content schema validates the choice against the
  backend's candidates before one retry. A declined, cancelled, invalid or empty answer for
  `deviceChoice` completes with the original refusal and never asks again. An update omitting
  the key leaves the task waiting. Cancelling the task while it waits settles it as cancelled.
- Task questions use the task's input waiter rather than MRTR `requestState` or the legacy
  20-second elicitation timeout. An unattended client leaves the task in `input_required`
  until answered, cancelled or expired by its task TTL. Running tasks currently advertise
  `ttlMs: null`, so there is no automatic input deadline. Legacy task calls are unchanged.
