export type FeatureFlagKey =
  | "debug"
  | "debug-perf"
  | "ui-perf-mode"
  | "mem-perf-audit"
  | "accessibility-audit"
  | "predictive-ui"
  | "force-accessibility-mode"
  | "accessibility-auto-detect"
  | "raw-element-search"
  | "ai-recovery"
  | "mcp-recording"
  | "navigation-screenshots"
  | "observe-result-drop-elements"
  | "observe-result-compact"
  | "tool-results-no-structured-content"
  | "actions-diff-observe"
  | "actions-no-observe";

export type FeatureFlagConfig = Record<string, unknown>;

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
    key: "observe-result-drop-elements",
    label: "Observe result: drop elements",
    description: "Omit the flattened elements array from observe results to reduce output size.",
    defaultValue: false,
  },
  {
    key: "observe-result-compact",
    label: "Observe result: compact",
    description: "Emit observe results in a compact form to reduce output size.",
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
    description: "Return only the diff of the observation after an action instead of the full observation.",
    defaultValue: false,
  },
  {
    key: "actions-no-observe",
    label: "Actions: no observe",
    description: "Skip returning the post-action observation entirely to reduce output size.",
    defaultValue: false,
  },
];
