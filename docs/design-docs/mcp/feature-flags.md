# Feature flags

Feature flags control optional AutoMobile behavior. Set process-wide flags when
starting the daemon:

```bash
auto-mobile --debug
auto-mobile --accessibility-audit
auto-mobile --mem-perf-audit
```

Common controls:

- `--debug` enables debug-only tools and diagnostics.
- `--accessibility-audit` adds accessibility checks to observations.
- `--mem-perf-audit` enables memory/performance diagnostics.
- `--embedded-sdk` enables capabilities that require the platform SDK.
- `--network-mockable` and `--mcp-recording` enable specialized test paths.

Flags are independent and cumulative. A tool may require both its tool
registration and a feature flag. Use `auto-mobile --cli help` to see the
options supported by the installed release.

For public tool selection, see [tool registration](tool-registration.md).

