# Feature Flags

<kbd>✅ Implemented</kbd>

> **Current state:** Feature flags are implemented as CLI args (e.g., `--debug`, `--accessibility-audit`, `--ui-perf-mode`). IDE integration for runtime flag toggling is described in linked docs but is `<kbd>🚧 Design Only</kbd>` for Android Studio and Xcode. See the [Status Glossary](../status-glossary.md) for chip definitions.

Runtime configuration system for experimental features, performance tuning, and debugging AutoMobile. At
present these flags can only be set on MCP startup as CLI args. The plan is to have them configurable via IDE integrations for
[Android Studio](../plat/android/ide-plugin/feature-flags.md) & [XCode](../plat/ios/ide-plugin/feature-flags.md)

### Debug Flags

**`--debug`** - Enable debug logging

**`--debug-perf`** / **`--ui-perf-debug`** - Enable performance debug output, including response performance audits

### Performance Flags

**`--ui-perf-mode`** - Enable UI performance monitoring

**`--mem-perf-audit`** - Memory performance auditing

### Behavior Flags

**`--accessibility-audit`** - Enable accessibility checks

**`--predictive-ui`** - AI-powered UI prediction

### Recording Flags

**`--mcp-recording`** - Enable the `recordSteps` tool for capturing MCP tool calls as replayable YAML test plans. Off by default.

### Output-Size Reduction Flags

Part of the MCP output-context reduction effort. Each flag can be set either as a CLI arg or via its `AUTOMOBILE_*` environment variable (set the env var to `1` to enable). The CLI flag wins when both are present. All are **off by default**.

| CLI flag | Environment variable | Effect |
|---|---|---|
| **`--observe-result-drop-elements`** | `AUTOMOBILE_OBSERVE_RESULT_DROP_ELEMENTS` | Omit the flattened `elements` array from `observe` results. |
| **`--observe-result-compact`** | `AUTOMOBILE_OBSERVE_RESULT_COMPACT` | Emit `observe` results in a compact form. |
| **`--tool-results-no-structured-content`** | `AUTOMOBILE_TOOL_RESULTS_NO_STRUCTURED_CONTENT` | Omit the `structuredContent` field from tool results. |
| **`--actions-diff-observe`** | `AUTOMOBILE_ACTIONS_DIFF_OBSERVE` | Return only the diff of the post-action observation instead of the full observation. |
| **`--actions-no-observe`** | `AUTOMOBILE_ACTIONS_NO_OBSERVE` | Skip returning the post-action observation entirely. |

> **Note on persistence:** like the other feature flags above, enabling one of these (via **either** the CLI flag or the env var) writes `enabled=true` to the daemon's feature-flag store, so it **stays on for subsequent daemon runs** until it is turned off through another surface — there is no `--no-*` CLI counterpart today. To clear a flag, toggle it off through the IDE feature-flag integration or reset the store.

> **Note on the shared daemon:** in the default proxy mode these flags are applied to the daemon at startup. If a daemon is **already running**, a new MCP client that requests a different flag value does **not** restart it — only `--embedded-sdk` (which changes the exposed tool surface) forces a daemon restart on mismatch, because restarting the shared daemon would disrupt any other connected clients. To pick up a changed output-reduction flag on an already-running daemon, restart the daemon (`--daemon restart`). This behavior is shared by all daemon-forwarded feature flags, not specific to these.
