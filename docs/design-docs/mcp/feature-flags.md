# Feature Flags

<kbd>✅ Implemented</kbd>

> **Current state:** Feature flags are implemented as CLI args (e.g., `--debug`, `--accessibility-audit`, `--mem-perf-audit`). IDE integration for runtime flag toggling is described in linked docs but is `<kbd>🚧 Design Only</kbd>` for Android Studio. See the [Status Glossary](../status-glossary.md) for chip definitions.

Runtime configuration system for experimental features, performance tuning, and debugging AutoMobile. At
present these flags are set on MCP startup as CLI args — and, for the output-size flags below, equivalently
via their `AUTOMOBILE_*` environment variables. The plan is to have them configurable via IDE integrations for
[Android Studio](../plat/android/ide-plugin/feature-flags.md)

### Debug Flags

**`--debug`** - Enable debug logging

**`--debug-perf`** / **`--ui-perf-debug`** - Enable performance debug output, including response performance audits

### Performance Flags

**`--no-ui-perf-mode`** - Disable UI performance monitoring. UI perf mode is **on by default** (`uiPerfMode = !args.includes("--no-ui-perf-mode")` in `src/index.ts`); there is no `--ui-perf-mode` enable flag — passing it has no effect since the mode is already on. Use `--no-ui-perf-mode` to turn off selection-state visual capture on taps and UI perf auditing.

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
| **`--observe-result-include-elements`** | `AUTOMOBILE_OBSERVE_RESULT_INCLUDE_ELEMENTS` | Opt back in to the flattened `elements` array on `observe` results. It is **dropped by default** to reduce output size; this flag restores it. (Note the default `observe` projection is the skeleton, which omits `elements` regardless — request `project: "full"` to get the full hierarchy, and combine with this flag to include `elements` there.) |
| **`--tool-results-no-structured-content`** | `AUTOMOBILE_TOOL_RESULTS_NO_STRUCTURED_CONTENT` | Omit the `structuredContent` field from tool results (the serialized `content[0].text` still carries the full payload, so no data is lost). Also drops the advertised `outputSchema` from `tools/list` so the server does not declare structured output it will not return. |
| **`--actions-diff-observe`** | `AUTOMOBILE_ACTIONS_DIFF_OBSERVE` | Non-observe tools (`tapOn`, `swipeOn`, …) emit a **diff** of their post-action observation against the last one shown to the agent, instead of the full embedded observation. The baseline is the "last observation output to the agent" — the sanitized `ObserveResult` cached per session (`SessionCacheData.lastRenderedObservation`). `observe` **always** emits the full sanitized observation and resets the baseline; each non-observe action emits its diff then updates the baseline to its own observation, so the next diff is against current state. Nodes carry no stable id, so diffing uses a synthetic key: `resource-id` + `bounds` + `text` + sibling index. The diff is `{ isDiff: true, added, removed, changed, fields }` — `added`/`removed`/`changed` are keyed nodes (a node whose key fields change reads as remove+add; a same-key node whose other attributes change, e.g. `checked`, reads as `changed`), and `fields` are changed top-level fields — scalars (`rotation`, `wakefulness`, `awaitDuration`, …; `updatedAt` is excluded as pure churn) and the Element **mirror** fields (`focusedElement`, `accessibilityFocusedElement`, `awaitedElement`), each as `{from, to}`. The mirror fields are emitted `node`-subtree-stripped (the subtree is redundant with the node diff) and compared bounds-tolerantly; a focus gain reads as `{from: undefined, to: element}`, a loss as `{from: element, to: undefined}`. **Falls back to the full observation** (no diff) when the active window/package changed (cross-screen diff is meaningless), the baseline is missing (first action), or there is no `sessionUuid` (legacy single-agent path). **Content-hash node identity (#3053):** the positional key cascades on scroll / mid-list insert — a shift changes every following node's `bounds` and sibling index, so whole rows would surface as remove+add. After positional matching, a leftover *removed* and *added* node are re-paired into one `changed` delta when they share a stable content key (`resource-id`/`view-id`/`content-desc`/`text` — no bounds, no sibling index) that is **unique among the leftovers on both sides**; uniqueness guarantees exactly one candidate each side, so distinct content never false-merges, and a keyless node (no stable identity) never re-pairs. This collapses a scroll into "N nodes moved" instead of "N removed + N added". Duplicate/interchangeable cells stay remove+add (ambiguous key). Applied output-only in `finalizeToolResponse` after `sanitizeObserveResult`, so it operates on the already-compacted observation (bounds compaction is a permanent default; the synthetic key normalizes both object- and tuple-shaped bounds). **Internal tool-to-tool calls are never diffed:** `PlanExecutor` marks its step calls internal (`__internalNoDiff`), so a plan step's finalized envelope always carries the full observation — a current or future internal `.observation.viewHierarchy` reader is never handed a diff. Combining it with `--actions-no-observe` is moot — that flag removes the observation, so there is nothing to diff. |
| **`--actions-no-observe`** | `AUTOMOBILE_ACTIONS_NO_OBSERVE` | Strip the embedded `observation` from non-observe tool results entirely (deleted from **both** `structuredContent` and the serialized `content[0].text`). Output-only — `BaseVisualChange` still computes the observation internally for its own success detection, so visual-change behavior is unchanged; the `observe` tool's own observation is never stripped. Applied at `finalizeToolResponse`. **Precedence:** when both `--actions-no-observe` and `--actions-diff-observe` are set, no-observe wins — the observation is removed, so there is nothing to diff. |

#### Now permanent defaults (formerly flags)

The following reductions were once opt-in flags and are now **unconditional defaults**. Their old flags and `AUTOMOBILE_*` env vars are **silently ignored** — passing one is a harmless no-op, with no error or migration warning:

- **Compact bounds tuples** (was `--observe-result-compact`): **every** `bounds` in an `observe` result is emitted as the positional tuple `[left, top, right, bottom]` instead of `{left, top, right, bottom}` — view-hierarchy nodes, `elements`, window/root/region, and the focused/awaited element fields. The order is fixed and round-trips losslessly; only fields literally named `bounds` are flattened, so insets keep their shape, and `rawViewHierarchy` (returned with `raw: true`) is left unshaped. The tuple arm is now advertised in `tools/list` unconditionally: `elementBoundsSchema` (`src/server/toolOutputSchemas.ts`) is a `bounds-object \| [left, top, right, bottom]` union, and `advertiseBoundsForCompact` (`src/server/compactBoundsAdvertisement.ts`) passes it through as-is (it is still suppressed together with the schema under `--tool-results-no-structured-content`).
- **Skeleton projection** (was `--observe-result-project-skeleton`): the headline `observe` payload projects to the flat, actionable-only `skeleton` (id/label/bounds/affordances) in place of `viewHierarchy` + `elements`. Opt out per call with `project: "full"` (or `raw: true`).
- **Compact (non-pretty) JSON** (was `--tool-results-compact-json`): tool results are serialized without the 2-space indentation in `stringifyToolResponse`. Same data (parses back identically, no effect on `tapOn`/text matching); ~35% fewer characters on element-heavy payloads.
- **Observe-scope gates** (were `--observe-focus-scope` / `--observe-overview` / `--observe-region`): the FOCUS / OVERVIEW / REGION dimensions of the `observe` `scope` input (see below) are always honored when a call supplies the matching `scope.*` field. A call with no `scope` is unaffected.

### Observe scope input (issue #4344)

Applies the multimodal "crop tool" concept to the **view hierarchy** (the artifact
agents consume) rather than screenshots: three progressive-disclosure transforms
that return a *scoped* view of the tree. This is the "spatial axis" complementing
`--actions-diff-observe`'s "temporal axis". Implemented output-only in
`finalizeToolResponse` (`src/features/observe/output/ObserveScopeExperiments.ts`),
so it never mutates the in-memory result, and applied to the **agent-facing**
`observe` payload only — internal tool-to-tool calls and the diff baseline keep
the full sanitized tree.

The parameters ride in the tool call: the agent picks where to zoom on **each**
screen via an optional `scope` field on `observe`. Scoping is always available —
`buildObserveScopeConfig` applies a dimension whenever the call requests it (the
per-dimension server gates that once dark-launched this are now always on).

| `scope` field | Shape | Behavior |
|---|---|---|
| `scope.focus` | `true` \| `{ resourceId?, text? }` | An anchor scopes to the first matching node's subtree; `true` scopes to the foreground app, dropping identifiable foreign-package chrome. FOCUS classifies chrome by the resource-id **dotted-package** prefix (`com.android.systemui:id/...`), which survives `cleanNodeProperties`; the undotted `android:` framework namespace (`android:id/content`, dialog/ActionBar ids) and iOS colon identifiers (`row:0`) are neutral and kept, so app content is never dropped. |
| `scope.region` | `true` \| `{ x1, y1, x2, y2 }` | Crop to a normalized `(0..1)` box (`x1<x2`, `y1<y2`, enforced at runtime), or the inset content rectangle when `true`. Nodes with no readable bounds are kept. |
| `scope.overview` | `true` | Collapse to a structural/addressable skeleton (kept: children, `scrollable`, `clickable`, `resource-id`, `content-desc`). |

Every scoped payload carries an `observeScope` field (`applied` transforms,
`nodesBefore`/`nodesAfter`, `regionPx`, `focus` resolution) so the reduction is
measurable on the wire. The `scope` input and `observeScope` output are advertised
in the `observe` tool schema.

### Tool Output Artifact Mode

`--tool-outputs-dir <path>` (alias `--tool-output-dir`; env
`AUTOMOBILE_TOOL_OUTPUTS_DIR` or legacy `AUTO_MOBILE_TOOL_OUTPUTS_DIR`) enables
artifact mode for large MCP tool-output subtrees. The directory is resolved to a
host-local path at startup and validated again at write time. Artifact write
failures are tool failures; AutoMobile does not fall back to inlining the large
payload.

Every artifact replacement uses the shared metadata shape:

```json
{
  "artifact": {
    "path": "/absolute/host/path/to/file.json",
    "format": "json",
    "payload": "NetworkGraph",
    "bytes": 123456,
    "tool": "getNetworkGraph"
  }
}
```

Artifact mode currently applies to:

- `observe`: the final agent-facing `ObserveResult` or `ObserveDiff` payload is written to an artifact after existing observe output transforms.
- Action tools with embedded `observation`: the embedded final agent-facing observation or diff is replaced with artifact metadata; internal tool-to-tool calls still receive full in-memory observations.
- `executePlan`: large `viewHierarchy` and `rawViewHierarchy` subtrees inside `failedStep.failureObservation` and captured debug observations are artifacted. Small fields such as success/counts/errors, device metadata, video paths, and observation samples remain inline.
- `bugReport`: `viewHierarchy.rawXml`, `logcat`, and long `windowState.windows` lists are artifacted. Report identity, device/screen state, hierarchy counts, clickable-element summary, saved report path, errors, and log counts remain inline.
- `getNetworkGraph`: the aggregate `graph` tree is artifacted, with `graphSummary.hostCount` left inline.

Evaluated but not selected for the first non-observation pass: `debugSearch`
returns bounded summaries rather than raw hierarchies; `exportPlan` and
`recordSteps` can return long YAML but that content is the primary result agents
usually need immediately. Revisit them if size tests or real-world traces show
they dominate context.

`--actions-diff-observe` chooses the full-vs-diff policy by action class before
calling the shared diff implementation. Navigation-prone actions (`tapOn`,
`tapAny`, `homeScreen`, `recentApps`, `openLink`, and `pressButton` for
back/home/recent/power, plus submit-style IME actions such as done/go/search/send)
use strict screen identity and prefer a full observation when identity is
uncertain, because a tap, navigation button, or submit action can move to a new
screen or modal. In-place mutations (`inputText` without a submit IME action,
`clearText`, `selectAllText`, focus-traversal `imeAction` values, keyboard and
clipboard operations, and non-navigation `pressButton`s such as volume) may diff
when the app/activity/package surface is stable and any present screen-identity
key still matches, even if that identity is low confidence. Scroll-like actions
(`swipeOn`, `dragAndDrop`) use the same stable-surface policy so scroll deltas can
stay compact while still falling back to full output across screens. The diff
shape remains `{ isDiff: true, added, removed, changed, fields }` for every
class; only the gate that decides whether a diff is safe changes.

> **Note on persistence:** like the other feature flags above, enabling one of these (via **either** the CLI flag or the env var) writes `enabled=true` to the daemon's feature-flag store, so it **stays on for subsequent daemon runs** until it is turned off through another surface — there is no `--no-*` CLI counterpart today. To clear a flag, toggle it off through the IDE feature-flag integration or reset the store.

> **Note on the shared daemon:** in the default proxy mode these flags are applied to the daemon at startup. If a daemon is **already running**, a new MCP client that requests a different output-reduction flag value does **not** restart it. `--embedded-sdk` (which changes the exposed tool surface) is the exception: a request to add it restarts the daemon with the existing options preserved. To pick up a changed output-reduction flag on an already-running daemon, restart the daemon (`--daemon restart`).

> **Note on `tools/list_changed` (issue #2963):** toggling a flag that changes tool definitions — the advertised `outputSchema` (`--tool-results-no-structured-content`) or tool availability (`--debug`) — emits a `notifications/tools/list_changed` at runtime so a directly-connected MCP client re-fetches `tools/list` and sees the updated advertisement. The set of tool-definition-affecting flags lives in `TOOL_DEFINITION_AFFECTING_FLAGS` (`src/features/featureFlags/FeatureFlagDefinitions.ts`) and is guarded against drift by a source-scan test. The emit is best-effort and fires only on an actual value change (no storm on redundant or unrelated toggles). In the default proxy topology `DaemonMcpProxy` **does** forward this notification: it invalidates its cached tool list and re-emits the event to the connected client via `sendToolListChanged()` (issue #3223, covered by `test/server/proxyServerListChanged.test.ts`), so a proxy-mode client re-fetches `tools/list` and sees the change without a daemon restart. The same path forwards `resources/list_changed`.
