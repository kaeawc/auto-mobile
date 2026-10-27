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

## Why it cannot stall an unattended call

Headless agents are most traffic and rarely declare elicitation, so they take the unchanged path. A
legacy harness that declares it but has nobody to answer is bounded by the timer, which aborts the request
(the SDK sends `notifications/cancelled`) and returns the refusal. The retry passes `deviceId`, so it
cannot ask twice. Modern requests return the question immediately without waiting on a timer; any
retry response map ends the question flow, and a valid selection runs the backend once more.

## Measuring before extending

Extending to confirmations needs data on which clients declare elicitation and how asks end
(accept, decline, timeout). This spike does not record either; add that counter before building more.

### MRTR limits (modern era)

- A tool call that runs as a task (the client declared the Tasks extension and the tool is
  task-eligible) returns its task handle immediately, so the device question is not asked on that
  call; the ambiguity refusal appears in the task's result.
