# Elicitation for an ambiguous device target

Spike for [#13945](https://github.com/kaeawc/auto-mobile/issues/13945): one flow (an
`ambiguous_device_target` refusal) may ask a supervising client which device to use. Confirmations
(`killDevice`, `uninstallApp`, data wipe) and the other candidate flows are out of scope until the
measurement below says otherwise.

## Contract

- A tool result that is the typed `ambiguous_device_target` refusal with two or more distinct
  candidates, on a call that names no `deviceId`, is intercepted by the shared `tools/call`
  envelope (`installToolCallDispatcher`).
- If the connection's client declared form elicitation, the server sends one `elicitation/create`
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

- Capability is read per connection from the server instance that owns the client's `initialize`
  (`getClientCapabilities()`), never cached. `elicitation.form`, or a bare `elicitation: {}`, counts;
  a URL-only declaration does not.
- Only servers with a stateful client connection ask: the stdio proxy and the direct stdio server.
  The daemon's HTTP layer is stateless (a server per request), so it has no channel to push a question
  on and never elicits; the proxy sees the daemon's refusal as a result and asks its own client.
- A request carrying a 2026-07-28 envelope has no push channel and never elicits. Adopting the
  SDK's multi-round-trip `inputRequired` for that era is the follow-up to the legacy push used here.

## Why it cannot stall an unattended call

Headless agents are most traffic and rarely declare elicitation, so they take the unchanged path. A
harness that declares it but has nobody to answer is bounded by the timer, which aborts the request
(the SDK sends `notifications/cancelled`) and returns the refusal. The retry passes `deviceId`, so it
cannot ask twice.

## Measuring before extending

Extending to confirmations needs data on which clients declare elicitation and how asks end
(accept, decline, timeout). This spike does not record either; add that counter before building more.
