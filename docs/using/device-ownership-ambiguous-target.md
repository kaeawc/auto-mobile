# Choosing a device for an ambiguous call

An unnamed call that matches several devices is refused with
`ambiguous_device_target` (see [Device ownership](device-ownership.md#what-is-refused)).
Some MCP clients can answer a question instead, so the call continues on the device you pick.

## When AutoMobile asks

AutoMobile asks when your MCP client connects over stdio and declares the
elicitation capability (form mode). The client shows the candidate devices, and
the call continues on the one you pick. Pass `deviceId` on the call to skip the
question.

You get the `ambiguous_device_target` refusal, unchanged, when:

- you decline or cancel;
- you do not answer within about 20 seconds;
- your client does not declare elicitation.

AutoMobile never holds unattended agents open.

After you decline or cancel, AutoMobile does not ask the same connection again
for the same set of devices, so you are not prompted on every call. A different
set of devices, a new connection, or an accepted answer asks again. Set
`AUTOMOBILE_ELICITATION=off` to never ask (CI, benchmarks): the call returns the
refusal immediately.

## Answering from code or a headless run

What happens to the question depends on how you run your client:

| Client setup                                       | What the question does                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Claude Code, interactive                           | Shows a dialog listing the devices; your pick continues the call.                                               |
| Claude Code `-p` (headless) with no hook           | Answered with `cancel` within milliseconds, so you get the `ambiguous_device_target` refusal. Nothing waits.    |
| Claude Agent SDK (TypeScript) with `onElicitation` | Your callback decides.                                                                                          |
| Claude Agent SDK (TypeScript) without a handler    | Declined automatically, so you get the refusal.                                                                 |
| Claude Agent SDK (Python) or the CLI               | There is no callback; only an `Elicitation` hook can answer. Without one the question is declined or cancelled. |

The Agent SDK runs Claude Code underneath, so an external AutoMobile server always sees Claude
Code's behavior, not a separate client.

### TypeScript `onElicitation`

The callback receives the request and returns an elicitation result:

```json
{
  "serverName": "automobile",
  "message": "tapOn matched 2 devices. Which device should it use?",
  "mode": "form",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "deviceId": {
        "type": "string",
        "title": "Device",
        "description": "The device this call should run on.",
        "oneOf": [
          { "const": "emulator-5554", "title": "emulator-5554 (android)" },
          { "const": "emulator-5556", "title": "emulator-5556 (android)" }
        ]
      }
    },
    "required": ["deviceId"]
  }
}
```

Answer with `{ "action": "accept", "content": { "deviceId": "emulator-5554" } }`, or
`{ "action": "decline" }` to get the refusal back. AutoMobile treats a `deviceId` it did not
offer as invalid and also returns the refusal.

### `Elicitation` hook (CLI and both SDKs)

A command hook in your settings receives:

```json
{
  "hook_event_name": "Elicitation",
  "mcp_server_name": "automobile",
  "message": "tapOn matched 2 devices. Which device should it use?",
  "mode": "form",
  "requested_schema": { "type": "object", "properties": { "deviceId": { "type": "string" } } }
}
```

and answers on stdout:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "Elicitation",
    "action": "accept",
    "content": { "deviceId": "emulator-5554" }
  }
}
```

A hook that always accepts picks a device without anyone looking, which can run a control
call on the wrong device. Have the hook choose by a rule you trust (for example the one device
that is booted), or decline. Pass `deviceId` on the call whenever you know it.
