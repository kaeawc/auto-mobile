export type FeatureFlagKey =
  | "debug"
  | "debug-perf"
  | "ui-perf-mode"
  | "mem-perf-audit"
  | "accessibility-audit"
  | "predictive-ui"
  | "force-accessibility-mode"
  | "accessibility-auto-detect"
  | "screen-reader-navigation"
  | "raw-element-search"
  | "ai-recovery"
  | "mcp-recording"
  | "navigation-screenshots"
  | "observe-result-include-elements"
  | "tool-results-no-structured-content"
  | "actions-diff-observe"
  | "actions-no-observe";

export type FeatureFlagConfig = Record<string, unknown>;

/**
 * Flags whose runtime toggle changes what `tools/list` returns — either the
 * advertised `outputSchema` or which tools are available — and therefore must
 * emit `notifications/tools/list_changed` so caching clients re-fetch. Kept as
 * the single source of truth consulted by {@link FeatureFlagService}; add a key
 * here (not per-flag logic) when a new flag starts influencing tool definitions.
 * See issue #2963.
 *
 * - `debug` toggles `debugOnly` tool availability (toolRegistry `isToolAvailable`).
 * - `tool-results-no-structured-content` suppresses `outputSchema` advertisement.
 *
 * Compact bounds tuples are now advertised unconditionally (the compaction that
 * once rode `observe-result-compact` is a permanent default), so no flag governs
 * that arm of the advertised `outputSchema` any longer.
 */
export const TOOL_DEFINITION_AFFECTING_FLAGS: ReadonlySet<FeatureFlagKey> = new Set<FeatureFlagKey>([
  "debug",
  "tool-results-no-structured-content",
]);

export interface FeatureFlagDefinition {
  key: FeatureFlagKey;
  label: string;
  description: string;
  defaultValue: boolean;
  defaultConfig?: FeatureFlagConfig;
}

export const FEATURE_FLAG_DEFINITIONS: FeatureFlagDefinition[] = [
  {
    key: "debug",
    label: "Debug mode",
    description: "Enable debug tools and include extra debug data in responses.",
    defaultValue: false,
  },
  {
    key: "debug-perf",
    label: "Debug perf (--debug-perf)",
    description: "Collect performance timing data in tool responses.",
    defaultValue: false,
  },
  {
    key: "ui-perf-mode",
    label: "UI performance audit",
    description: "Run UI performance audits during observe.",
    defaultValue: false,
  },
  {
    key: "mem-perf-audit",
    label: "Memory audit",
    description: "Run memory audits during tool execution.",
    defaultValue: false,
  },
  {
    key: "accessibility-audit",
    label: "Accessibility audit",
    description: "Run accessibility audits during observe.",
    defaultValue: false,
    defaultConfig: {
      level: "AA",
      failureMode: "report",
      minSeverity: "warning",
      useBaseline: false,
      contrast: {
        useMultiPointSampling: true,
        detectGradients: true,
        compositeOverlays: false,
        detectTextShadows: false,
        samplingPoints: 9,
      },
    },
  },
  {
    key: "predictive-ui",
    label: "Predictive UI",
    description: "Enable predictive UI state generation during observe.",
    defaultValue: false,
  },
  {
    key: "raw-element-search",
    label: "Raw element search",
    description: "Use raw view hierarchies for element search while returning filtered observations.",
    defaultValue: false,
  },
  {
    key: "force-accessibility-mode",
    label: "Force accessibility mode",
    description: "Force-enable accessibility mode for testing (overrides auto-detection).",
    defaultValue: false,
  },
  {
    key: "accessibility-auto-detect",
    label: "Accessibility auto-detect",
    description: "Automatically detect and adapt to TalkBack/VoiceOver when enabled.",
    defaultValue: true,
  },
  {
    key: "screen-reader-navigation",
    label: "Screen-reader navigation (fidelity mode)",
    description:
      "Opt-in: when a screen reader is active, drive the cursor by swipe traversal to the target before activating (reproduces the real user journey) instead of activating the node directly. For accessibility validation — reachability, traversal order, focus traps.",
    defaultValue: false,
  },
  {
    key: "ai-recovery",
    label: "AI recovery",
    description: "AI-assisted recovery for failed test steps.",
    defaultValue: true,
    defaultConfig: {
      maxToolCalls: 5,
    },
  },
  {
    key: "mcp-recording",
    label: "MCP call recording",
    description: "Enable the recordSteps tool to capture MCP tool calls as replayable YAML test plans.",
    defaultValue: false,
  },
  {
    key: "navigation-screenshots",
    label: "Navigation screenshots",
    description: "Capture screenshots on navigation events to enrich the navigation graph. Disable to reduce device resource usage.",
    defaultValue: true,
  },
  {
    key: "observe-result-include-elements",
    label: "Observe result: include elements",
    description: "Include the flattened elements array in observe results. It is dropped by default to reduce output size; enable this to restore it.",
    defaultValue: false,
  },
  {
    key: "tool-results-no-structured-content",
    label: "Tool results: no structured content",
    description: "Omit the structuredContent field from tool results to reduce output size.",
    defaultValue: false,
  },
  {
    key: "actions-diff-observe",
    label: "Actions: diff observe",
    description: "Return action-aware observation diffs after non-observe tools, falling back to full observations for navigation-prone or uncertain screen changes.",
    defaultValue: false,
  },
  {
    key: "actions-no-observe",
    label: "Actions: no observe",
    description: "Skip returning the post-action observation entirely to reduce output size.",
    defaultValue: false,
  },
];
