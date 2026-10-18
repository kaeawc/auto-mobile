import { EVENT_ALL_MARKERS_FLAG } from "../utils/eventAllMarkers";
import { outputReductionFlagsToArgs } from "../utils/outputReductionFlags";
import { RUNNER_READINESS_TIMEOUT_FLAG } from "../utils/runnerReadinessConfig";
import type { DaemonOptions } from "./types";

/** A flag whose presence is the option's truthiness. */
interface BooleanFlag {
  readonly flag: string;
  readonly option: keyof DaemonOptions;
}

/** A flag followed by the option's value; `present` decides when the option is serialized. */
interface ValueFlag {
  readonly flag: string;
  readonly option: keyof DaemonOptions;
  readonly present: "truthy" | "defined";
}

type FlagSpec = BooleanFlag | ValueFlag;

const isValueFlag = (spec: FlagSpec): spec is ValueFlag => "present" in spec;

const bool = (flag: string, option: keyof DaemonOptions): BooleanFlag => ({ flag, option });
const truthy = (flag: string, option: keyof DaemonOptions): ValueFlag => ({
  flag,
  option,
  present: "truthy",
});
const defined = (flag: string, option: keyof DaemonOptions): ValueFlag => ({
  flag,
  option,
  present: "defined",
});

/** Serialized in this order: the launch command line is observed by tests and by `ps`. */
const LEADING_FLAGS: readonly FlagSpec[] = [
  truthy("--port", "port"),
  truthy("--host", "host"),
  bool("--strict-port", "strictPort"),
  bool("--debug", "debug"),
  bool("--debug-perf", "debugPerf"),
  truthy("--plan-execution-lock-scope", "planExecutionLockScope"),
  defined(RUNNER_READINESS_TIMEOUT_FLAG, "runnerReadinessTimeoutMs"),
  truthy("--video-quality", "videoQualityPreset"),
  defined("--video-target-bitrate-kbps", "videoTargetBitrateKbps"),
  defined("--video-max-throughput-mbps", "videoMaxThroughputMbps"),
  defined("--video-fps", "videoFps"),
  truthy("--video-format", "videoFormat"),
  defined("--video-archive-size-mb", "videoMaxArchiveSizeMb"),
  bool("--network-mockable", "networkMockable"),
  bool("--embedded-sdk", "embeddedSdk"),
];

const AFTER_TOOL_FLAGS: readonly FlagSpec[] = [
  bool("--dismiss-keyboard-after-input", "dismissKeyboardAfterInput"),
];

// Accessibility-service view-filter flags (issue #4344 propagation audit): these were in the
// daemon-options object but serialized nowhere, so a manager-spawned daemon never received them
// on either transport.
const TRAILING_FLAGS: readonly FlagSpec[] = [
  bool("--no-ui-perf-mode", "noUiPerfMode"),
  bool("--no-navigation-screenshots", "noNavigationScreenshots"),
  bool("--no-waitfor-polling-overhead", "noWaitForPollingOverhead"),
  bool("--no-occlusion", "noOcclusion"),
  bool("--no-include-not-important-views", "noA11yIncludeNotImportantViews"),
  bool("--no-report-view-ids", "noA11yReportViewIds"),
  bool("--no-retrieve-interactive-windows", "noA11yRetrieveInteractiveWindows"),
  bool("--mem-perf-audit", "memPerfAudit"),
  bool("--accessibility-audit", "accessibilityAudit"),
  truthy("--a11y-level", "accessibilityLevel"),
  truthy("--a11y-failure-mode", "accessibilityFailureMode"),
  truthy("--a11y-min-severity", "accessibilityMinSeverity"),
  bool("--a11y-use-baseline", "accessibilityUseBaseline"),
  bool("--predictive-ui", "predictiveUi"),
  bool("--raw-element-search", "rawElementSearch"),
  bool("--skip-ctrl-proxy-download", "skipCtrlProxyDownload"),
  bool("--tool-call-recording", "toolCallRecording"),
];

function serializeFlags(options: DaemonOptions, specs: readonly FlagSpec[]): string[] {
  return specs.flatMap((spec) => {
    const value = options[spec.option];
    if (!isValueFlag(spec)) {
      return value ? [spec.flag] : [];
    }
    const present = spec.present === "defined" ? value !== undefined : Boolean(value);
    return present ? [spec.flag, String(value)] : [];
  });
}

function toolArgs(flag: string, toolNames: readonly string[] | undefined): string[] {
  return (toolNames ?? []).flatMap((toolName) => [flag, toolName]);
}

function eventAllMarkerArgs(options: DaemonOptions): string[] {
  if (options.eventAllMarkers && options.eventAllMarkers.length > 0) {
    return [EVENT_ALL_MARKERS_FLAG, options.eventAllMarkers.join(",")];
  }
  return options.eventAllMarkersCliOverride ? [`${EVENT_ALL_MARKERS_FLAG}=`] : [];
}

/** The daemon command-line flags that carry `options` to a manager-spawned daemon. */
export function daemonOptionsToArgs(options: DaemonOptions): string[] {
  return [
    ...serializeFlags(options, LEADING_FLAGS),
    ...toolArgs("--enable-tool", options.enabledTools),
    ...toolArgs("--disable-tool", options.disabledTools),
    ...serializeFlags(options, AFTER_TOOL_FLAGS),
    ...eventAllMarkerArgs(options),
    ...serializeFlags(options, TRAILING_FLAGS),
    // Output-reduction flags (issue #2756): serialized off the shared specs so they can't drift
    // from the daemon-side parse in parseDaemonArgs.
    ...outputReductionFlagsToArgs(options),
  ];
}
