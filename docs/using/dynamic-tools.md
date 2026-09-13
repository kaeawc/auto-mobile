# Dynamic Tools

AutoMobile lets you enable or disable public tools by their exact,
case-sensitive names. `setToolEnabled` is always available:

```json
{
  "name": "setToolEnabled",
  "arguments": { "toolName": "clipboard", "enabled": true }
}
```

Set `enabled` to `false` to disable a tool. An optional `sessionUuid` scopes
the choice to a routing session. The choice persists across daemon restarts.

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

Either spelling returns `enabledTools` — the user-configurable tools that are
enabled for the session after the call — so the resulting capability set is
visible without a second `tools/list`.

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
and `getApple` report both `gatedTools` (still disabled) and `enabledTools`
(the complement) in their response; `provisionDevice` reports `enabledTools`.

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
