# Dynamic Tools

AutoMobile lets you control which public tools appear in `tools/list` by their
exact, case-sensitive names. `setToolEnabled` is always available. Selection
controls discovery only: a client can still invoke an omitted tool directly by
name through `tools/call`:

```json
{
  "name": "setToolEnabled",
  "arguments": { "toolName": "clipboard", "enabled": true }
}
```

Set `enabled` to `false` to omit a tool from discovery. An optional
`sessionUuid` scopes the choice to a routing session. The choice persists
across daemon restarts.

## Enabling several tools at once

Pass `toolNames` instead of `toolName` to declare a whole task's toolset in one
round-trip. The batch is all-or-nothing: an unknown or non-configurable name
rejects the request before anything is written.

```json
{
  "name": "setToolEnabled",
  "arguments": { "toolNames": ["inputText", "clearText", "imeAction"] }
}
```

Either spelling returns `enabledTools` — the user-configurable tools selected
for discovery in the session after the call — so the resulting discovery set is
visible without a second `tools/list`.
If the write succeeds but the follow-up read of that set fails, the response
returns `enabledToolsError` instead of `enabledTools`; the change was still
applied. Confirm the resulting set with `tools/list` or a follow-up
`setToolEnabled` call.

## Declaring capabilities at device acquisition

`getAndroid`, `getApple`, and `provisionDevice` accept `enableTools`, applied
while the session is minted, so acquisition and capability declaration are one
call:

```json
{
  "name": "getAndroid",
  "arguments": {
    "avdName": "Pixel_9",
    "enableTools": ["inputText", "clearText", "imeAction"]
  }
}
```

An unknown name rejects the call before any device work starts. `getAndroid`
and `getApple` report both `gatedTools` (omitted from discovery) and `enabledTools`
(the complement) in their response; `provisionDevice` reports `enabledTools`
and requires `boot: true`, since a no-boot provision mints no session to
declare capabilities against.
Both reports resolve a tool the same way `tools/list` does — the union of the
connection profile and the routing session — so every tool they list is one the
next `tools/list` will advertise. A direct `tools/call` can invoke an omitted tool.

If the device is acquired but the capability declaration itself cannot be
persisted, the response keeps its session handle and adds an `enableToolsError`
describing what did not land; re-declare those tools with `setToolEnabled`.

## Startup defaults

Use repeatable CLI flags or comma-separated environment variables:

```bash
auto-mobile --enable-tool clipboard --enable-tool sqlQuery
auto-mobile --disable-tool observe

export AUTOMOBILE_ENABLED_TOOLS=clipboard,sqlQuery
export AUTOMOBILE_DISABLED_TOOLS=observe
```

Names and casing must match the registered tool exactly. Unknown names and
conflicts in the same layer fail startup. Persisted session choices take
precedence over CLI values, which take precedence over environment values and
built-in defaults.

Some tools also require a process option such as `--debug`, `--embedded-sdk`,
or `--mcp-recording`. Plan-only tools are never shown in public discovery.

If a tool is missing, check its exact name and required process options, then
refresh discovery after the `notifications/tools/list_changed` notification.

## Device-session recovery after a daemon restart

A shared-daemon restart ends every device session bound to its prior daemon
instance. Do not retry or retarget the former session UUID: acquire a fresh
session with `getAndroid` or `getApple` before continuing.
