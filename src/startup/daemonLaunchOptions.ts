import type { DaemonOptions } from "../daemon/types";
import type { AccessibilityAuditConfig } from "./featureFlagStartup";
import type { ParsedArgs } from "./startupContext";

export type EventAllMarkerOptions = Pick<
  DaemonOptions,
  "eventAllMarkers" | "eventAllMarkersCliOverride"
>;

export function eventAllMarkerOptions(args: ParsedArgs): EventAllMarkerOptions {
  const { eventAllMarkers, eventAllMarkersCliOverride } = args;
  return eventAllMarkers.length > 0 || eventAllMarkersCliOverride
    ? { eventAllMarkers, eventAllMarkersCliOverride }
    : {};
}

/** The options a `--daemon-mode` process starts its own daemon with. */
export function buildDaemonModeOptions(
  args: ParsedArgs,
  markers: EventAllMarkerOptions,
): DaemonOptions {
  const { videoRecordingDefaults: video, runnerReadinessTimeoutMs, daemonHost } = args;
  return {
    port: args.daemonPort,
    ...(daemonHost !== undefined ? { host: daemonHost } : {}),
    strictPort: args.strictPort,
    debug: args.debug,
    debugPerf: args.debugPerf,
    planExecutionLockScope: args.planExecutionLockScope,
    ...(runnerReadinessTimeoutMs !== undefined ? { runnerReadinessTimeoutMs } : {}),
    videoQualityPreset: video.qualityPreset,
    videoTargetBitrateKbps: video.targetBitrateKbps,
    videoMaxThroughputMbps: video.maxThroughputMbps,
    videoFps: video.fps,
    videoFormat: video.format,
    videoMaxArchiveSizeMb: video.maxArchiveSizeMb,
    toolOutputsDir: args.toolOutputsDir,
    networkMockable: args.networkMockable,
    embeddedSdk: args.embeddedSdk,
    enabledTools: args.enabledTools,
    disabledTools: args.disabledTools,
    dismissKeyboardAfterInput: args.dismissKeyboardAfterInput,
    ...markers,
    noUiPerfMode: !args.uiPerfMode,
    memPerfAudit: args.memPerfAuditMode,
    accessibilityAudit: args.a11yAuditMode,
    accessibilityLevel: args.a11yLevel,
    accessibilityFailureMode: args.a11yFailureMode,
    accessibilityMinSeverity: args.a11yMinSeverity,
    accessibilityUseBaseline: args.a11yUseBaseline,
    predictiveUi: args.predictiveUi,
    rawElementSearch: args.rawElementSearch,
    skipCtrlProxyDownload: args.skipCtrlProxyDownload,
    toolCallRecording: args.toolCallRecording,
    noNavigationScreenshots: !args.navigationScreenshots,
    noWaitForPollingOverhead: args.noWaitForPollingOverhead,
    noA11yIncludeNotImportantViews: args.noA11yIncludeNotImportantViews,
    noA11yReportViewIds: args.noA11yReportViewIds,
    noA11yRetrieveInteractiveWindows: args.noA11yRetrieveInteractiveWindows,
    noOcclusion: args.noOcclusion,
    // OutputReductionFlags field names match these DaemonOptions fields 1:1.
    ...args.outputReduction,
  };
}

/**
 * Single source of truth for the startup options handed to the daemon, shared by BOTH transports
 * (issue #4344 propagation audit). Threading the full set into the `--cli` path too — not just
 * `{embeddedSdk, networkMockable}` — closes a gap where output-reduction / observe-scope /
 * a11y-audit / predictive flags requested on the CLI transport never reached (or restarted) the
 * daemon, while the stdio proxy path relayed them. One object also means the two transports can
 * never drift apart again.
 */
export function buildDaemonStartupOptions(
  args: ParsedArgs,
  accessibilityConfig: AccessibilityAuditConfig | null,
  markers: EventAllMarkerOptions,
): DaemonOptions {
  return {
    ...connectionOptions(args),
    ...videoAndToolOptions(args),
    ...markers,
    ...viewFilterOptions(args),
    ...auditOptions(args, accessibilityConfig),
    // OutputReductionFlags field names match these DaemonOptions fields 1:1.
    ...args.outputReduction,
    // The positive flag is an explicit connection preference. Its absence is
    // no preference, so the daemon's global fallback remains authoritative.
    toolResultsNoStructuredContent: args.outputReduction.toolResultsNoStructuredContent
      ? true
      : undefined,
  };
}

function connectionOptions(args: ParsedArgs): DaemonOptions {
  const { daemonPort, daemonHost, runnerReadinessTimeoutMs } = args;
  return {
    ...(daemonPort !== undefined ? { port: daemonPort } : {}),
    ...(daemonHost !== undefined ? { host: daemonHost } : {}),
    ...(args.strictPort ? { strictPort: true } : {}),
    ...(args.debug ? { debug: true } : {}),
    ...(args.debugPerf ? { debugPerf: true } : {}),
    ...(args.planExecutionLockScopeExplicit
      ? { planExecutionLockScope: args.planExecutionLockScope }
      : {}),
    ...(runnerReadinessTimeoutMs !== undefined ? { runnerReadinessTimeoutMs } : {}),
    ...(args.toolCallRecording ? { toolCallRecording: true } : {}),
  };
}

function videoAndToolOptions(args: ParsedArgs): DaemonOptions {
  const video = args.videoRecordingDefaults;
  return {
    videoQualityPreset: video.qualityPreset,
    videoTargetBitrateKbps: video.targetBitrateKbps,
    videoMaxThroughputMbps: video.maxThroughputMbps,
    videoFps: video.fps,
    videoFormat: video.format,
    videoMaxArchiveSizeMb: video.maxArchiveSizeMb,
    toolOutputsDir: args.toolOutputsDir,
    ...(args.networkMockable ? { networkMockable: true } : {}),
    ...(args.embeddedSdk ? { embeddedSdk: true } : {}),
    ...(args.enabledTools.length > 0 ? { enabledTools: args.enabledTools } : {}),
    ...(args.disabledTools.length > 0 ? { disabledTools: args.disabledTools } : {}),
    ...(args.dismissKeyboardAfterInput ? { dismissKeyboardAfterInput: true } : {}),
  };
}

function viewFilterOptions(args: ParsedArgs): DaemonOptions {
  return {
    ...(!args.uiPerfMode ? { noUiPerfMode: true } : {}),
    ...(!args.navigationScreenshots ? { noNavigationScreenshots: true } : {}),
    ...(args.noWaitForPollingOverhead ? { noWaitForPollingOverhead: true } : {}),
    ...(args.noA11yIncludeNotImportantViews ? { noA11yIncludeNotImportantViews: true } : {}),
    ...(args.noA11yReportViewIds ? { noA11yReportViewIds: true } : {}),
    ...(args.noA11yRetrieveInteractiveWindows ? { noA11yRetrieveInteractiveWindows: true } : {}),
    ...(args.noOcclusion ? { noOcclusion: true } : {}),
  };
}

function auditOptions(
  args: ParsedArgs,
  accessibilityConfig: AccessibilityAuditConfig | null,
): DaemonOptions {
  return {
    ...(args.memPerfAuditMode ? { memPerfAudit: true } : {}),
    ...(args.a11yAuditMode ? { accessibilityAudit: true } : {}),
    ...(accessibilityConfig
      ? {
          accessibilityLevel: accessibilityConfig.level,
          accessibilityFailureMode: accessibilityConfig.failureMode,
          accessibilityMinSeverity: accessibilityConfig.minSeverity,
          accessibilityUseBaseline: accessibilityConfig.useBaseline,
        }
      : {}),
    ...(args.predictiveUi ? { predictiveUi: true } : {}),
    ...(args.rawElementSearch ? { rawElementSearch: true } : {}),
    ...(args.skipCtrlProxyDownload ? { skipCtrlProxyDownload: true } : {}),
  };
}
