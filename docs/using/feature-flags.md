# Feature Flags

Feature flags control optional AutoMobile behavior. Set them as CLI arguments
when starting the MCP server. Flags are independent and cumulative.

## Debug Flags

- `--debug` — enable debug logging.
- `--debug-perf` or `--ui-perf-debug` — enable performance debug output,
  including response-performance audits.

## Performance Flags

- `--ui-perf-mode` — enable UI performance monitoring.
- `--mem-perf-audit` — enable memory-performance auditing.

## Behavior Flags

- `--accessibility-audit` — enable accessibility checks.
- `--predictive-ui` — enable AI-powered UI prediction.

## Recording Flags

- `--mcp-recording` — enable the `recordSteps` tool for capturing MCP tool
  calls as replayable YAML test plans. It is off by default.

Use `auto-mobile --cli help` to see the options supported by the installed
release. A tool may require both its registration gate and a feature flag; see
[Dynamic Tools](dynamic-tools.md).
