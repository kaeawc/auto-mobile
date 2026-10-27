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
  `input_required` embeds the device question as `inputRequests.deviceChoice`. A retry carries the
  answer in `inputResponses.deviceChoice`. No `requestState` is needed: the backend runs again and
  the accepted device must be in its current candidate list. A declined, cancelled, invalid or empty
  response map returns that refusal unchanged and never asks again.

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
- The answer is not bound to the call that asked (there is no `requestState`). An answer attached
  to a different ambiguous call is accepted only when it names a device that call's own refusal
  offers, so it cannot select a device the caller could not already see.
