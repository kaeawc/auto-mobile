# Per-tool Selection & Registration Gates

<kbd>✅ Implemented</kbd>

AutoMobile exposes each user-configurable MCP tool according to its exact,
case-sensitive tool name. There are no tool groups: enabling `clipboard` does not
enable `selectAllText`, and enabling `videoRecording` does not enable
`deviceSnapshot`.

## Runtime selection

Call the always-available `setToolEnabled` tool:

```json
{ "name": "setToolEnabled", "arguments": { "toolName": "clipboard" } }
```

Parameters:

- `toolName` (required): an exact tool name currently registered as public and
  user-configurable.
- `enabled` (optional, default `true`): set to `false` to disable that tool.
- `sessionUuid` (optional): the active connection or routing-session profile to
  update. Omit it for the normal connection-scoped behavior.

Unknown names, aliases, wrong casing, hidden tools, plan-only tools, and
`setToolEnabled` itself are rejected. A successful update persists in SQLite,
survives daemon restarts, and emits `notifications/tools/list_changed`.

`setToolEnabled` controls public discovery and public calls. Internal plan and
orchestration calls are authorized by their outer operation and do not repeat
the public session-selection check.

## Startup defaults

Startup defaults also use exact tool names:

```bash
auto-mobile --enable-tool clipboard --enable-tool sqlQuery --disable-tool observe

export AUTOMOBILE_ENABLED_TOOLS=clipboard,sqlQuery
export AUTOMOBILE_DISABLED_TOOLS=observe
```

Both CLI flags are repeatable. Environment values are comma-separated. Unknown
names, wrong casing, and a tool enabled and disabled in the same layer fail
startup. CLI values override environment values for the same tool.

Precedence, from strongest to weakest:

1. persisted per-session override;
2. CLI startup override;
3. environment startup override;
4. the tool's declared built-in default.

The former `AUTOMOBILE_TOOLSET_*` variables are retired and cause startup to
fail with migration guidance.

## Independent cumulative gates

Per-tool selection does not replace these existing gates:

- `debugOnly`: requires the persistent debug feature flag (`--debug` or
  `AUTOMOBILE_DEBUG=1`);
- `embeddedSdkOnly`: requires `--embedded-sdk` for the process;
- `planOnly`: always hidden from public discovery and callable only inside plans;
- action gates such as `--network-mockable` and `--mcp-recording`.

All gates are cumulative. For example, enabling `navigateTo` still does not
expose it until its debug and embedded-SDK gates are also satisfied.

## Session and device routing

Base and derived device-label sessions retain union semantics: a device-aware
public call is enabled when either relevant session explicitly enables the exact
tool. A connection-scoped disable overrides inherited defaults, while an
explicit routing-session enable may opt the tool back in.

Connection selection profiles remain separate from device routing, so releasing
an `executePlan` device session does not discard the still-open connection's
tool choices.

## Troubleshooting

If a tool is missing:

1. use the exact registered name with `setToolEnabled`;
2. check `debugOnly`, `embeddedSdkOnly`, and action gates;
3. remember that plan-only tools never appear in `tools/list`;
4. refresh discovery after `notifications/tools/list_changed`.

See [Environment Variables](environment-variables.md) and
[Feature Flags](../design-docs/mcp/feature-flags.md) for the independent
process-wide controls.
