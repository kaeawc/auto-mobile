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
| **`--observe-result-compact`** | `AUTOMOBILE_OBSERVE_RESULT_COMPACT` | Emit `observe` results in a compact form: **every** `bounds` object in the result is flattened from `{left, top, right, bottom}` to the positional tuple `[left, top, right, bottom]` — view-hierarchy nodes, the `elements` arrays, window/root/region bounds, and the focused/awaited element fields. The order is fixed and documented, so the tuple round-trips losslessly; the four repeated key strings are dropped from every occurrence. Only fields literally named `bounds` are flattened, so insets (`systemInsets`, a `{top,bottom,left,right}` object) keep their shape. `rawViewHierarchy` (returned with `raw: true`) is left unshaped. Applied output-only (the in-memory `lastHierarchy` cache is unaffected) and composes with `--observe-result-drop-elements`, `--tool-results-no-structured-content`, `--actions-diff-observe`, and `--actions-no-observe` (the latter removes the post-action `observation`, so there is nothing to flatten). The tuple shape is advertised machine-readably **only when this flag is on**: every tool `outputSchema` that carries a typed `bounds` field routes through `elementBoundsSchema` (`src/server/toolOutputSchemas.ts`), a `bounds-object \| [left, top, right, bottom]` union whose `description` names the tuple order and the enabling flag. `advertiseBoundsForCompact` (`src/server/compactBoundsAdvertisement.ts`) collapses that union to its object arm in `tools/list` when the flag is off, so the advertised shape always matches the emitted shape (mirroring the `--tool-results-no-structured-content` `outputSchema` suppression). Note the `observe` tool itself declares no `outputSchema`, so hierarchy-node/window bounds are documented only in prose here — the union reaches a client via the summary-element bounds on schema-declaring tools such as `tapOn` and `accessibilityFocus`. |
| **`--tool-results-no-structured-content`** | `AUTOMOBILE_TOOL_RESULTS_NO_STRUCTURED_CONTENT` | Omit the `structuredContent` field from tool results (the serialized `content[0].text` still carries the full payload, so no data is lost). Also drops the advertised `outputSchema` from `tools/list` so the server does not declare structured output it will not return. |
| **`--actions-diff-observe`** | `AUTOMOBILE_ACTIONS_DIFF_OBSERVE` | Non-observe tools (`tapOn`, `swipeOn`, …) emit a **diff** of their post-action observation against the last one shown to the agent, instead of the full embedded observation. The baseline is the "last observation output to the agent" — the sanitized `ObserveResult` cached per session (`SessionCacheData.lastRenderedObservation`). `observe` **always** emits the full sanitized observation and resets the baseline; each non-observe action emits its diff then updates the baseline to its own observation, so the next diff is against current state. Nodes carry no stable id, so diffing uses a synthetic key: `resource-id` + `bounds` + `text` + sibling index. The diff is `{ isDiff: true, added, removed, changed, fields }` — `added`/`removed`/`changed` are keyed nodes (a node whose key fields change reads as remove+add; a same-key node whose other attributes change, e.g. `checked`, reads as `changed`), and `fields` are changed top-level fields — scalars (`rotation`, `wakefulness`, `awaitDuration`, …; `updatedAt` is excluded as pure churn) and the Element **mirror** fields (`focusedElement`, `accessibilityFocusedElement`, `awaitedElement`), each as `{from, to}`. The mirror fields are emitted `node`-subtree-stripped (the subtree is redundant with the node diff) and compared bounds-tolerantly; a focus gain reads as `{from: undefined, to: element}`, a loss as `{from: element, to: undefined}`. **Falls back to the full observation** (no diff) when the active window/package changed (cross-screen diff is meaningless), the baseline is missing (first action), or there is no `sessionUuid` (legacy single-agent path). **Content-hash node identity (#3053):** the positional key cascades on scroll / mid-list insert — a shift changes every following node's `bounds` and sibling index, so whole rows would surface as remove+add. After positional matching, a leftover *removed* and *added* node are re-paired into one `changed` delta when they share a stable content key (`resource-id`/`view-id`/`content-desc`/`text` — no bounds, no sibling index) that is **unique among the leftovers on both sides**; uniqueness guarantees exactly one candidate each side, so distinct content never false-merges, and a keyless node (no stable identity) never re-pairs. This collapses a scroll into "N nodes moved" instead of "N removed + N added". Duplicate/interchangeable cells stay remove+add (ambiguous key). Applied output-only in `finalizeToolResponse` after `sanitizeObserveResult`, so it composes with `--observe-result-compact` (the diff operates on the already-compacted observation; the synthetic key normalizes both object- and tuple-shaped bounds). **Internal tool-to-tool calls are never diffed:** `PlanExecutor` marks its step calls internal (`__internalNoDiff`), so a plan step's finalized envelope always carries the full observation — a current or future internal `.observation.viewHierarchy` reader is never handed a diff. Combining it with `--actions-no-observe` is moot — that flag removes the observation, so there is nothing to diff. |
| **`--actions-no-observe`** | `AUTOMOBILE_ACTIONS_NO_OBSERVE` | Strip the embedded `observation` from non-observe tool results entirely (deleted from **both** `structuredContent` and the serialized `content[0].text`). Output-only — `BaseVisualChange` still computes the observation internally for its own success detection, so visual-change behavior is unchanged; the `observe` tool's own observation is never stripped. Applied at `finalizeToolResponse`. **Precedence:** when both `--actions-no-observe` and `--actions-diff-observe` are set, no-observe wins — the observation is removed, so there is nothing to diff. |
| **`--tool-results-compact-json`** | `AUTOMOBILE_TOOL_RESULTS_COMPACT_JSON` | Serialize tool results as compact (non-pretty-printed) JSON — drops the 2-space indentation in `stringifyToolResponse`. Same data (parses back identically, no effect on `tapOn`/text matching); ~35% fewer characters on element-heavy payloads. Composes with the other flags. |

> **Note on persistence:** like the other feature flags above, enabling one of these (via **either** the CLI flag or the env var) writes `enabled=true` to the daemon's feature-flag store, so it **stays on for subsequent daemon runs** until it is turned off through another surface — there is no `--no-*` CLI counterpart today. To clear a flag, toggle it off through the IDE feature-flag integration or reset the store.

> **Note on the shared daemon:** in the default proxy mode these flags are applied to the daemon at startup. If a daemon is **already running**, a new MCP client that requests a different flag value does **not** restart it — only `--embedded-sdk` (which changes the exposed tool surface) forces a daemon restart on mismatch, because restarting the shared daemon would disrupt any other connected clients. To pick up a changed output-reduction flag on an already-running daemon, restart the daemon (`--daemon restart`). This behavior is shared by all daemon-forwarded feature flags, not specific to these.
