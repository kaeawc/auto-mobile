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
