# Elicitation for an ambiguous device target

- Kind: decision
- Date: 2026-10-26
- Source: moved from `how-it-works/mcp/elicitation-ambiguous-device.md`; #13945, #15441
- Shaped: [Elicitation for an ambiguous device target](../how-it-works/mcp/elicitation-ambiguous-device.md)

## Context

Spike #13945 asked whether the server should elicit from a supervising client. Candidate flows
included the `ambiguous_device_target` refusal and confirmations (`killDevice`, `uninstallApp`,
data wipe).

## Options

Not recorded.

## Decision

Only the `ambiguous_device_target` refusal asks. Confirmations and the other candidate flows stay
out of scope until the measurement says otherwise.

## Consequences

Extending to confirmations needs data on which clients declare elicitation and how asks end, so
every ambiguous-device refusal on a call without `deviceId` produces one `ElicitationRecord`.
