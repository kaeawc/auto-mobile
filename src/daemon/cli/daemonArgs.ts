import { shouldSkipCtrlProxyDownload } from "../../utils/ctrlProxyDownloadControl";
import {
  hasEventAllMarkersCliOverride,
  parseEventAllMarkersConfig,
} from "../../utils/eventAllMarkers";
import {
  parseRunnerReadinessTimeout,
  RUNNER_READINESS_TIMEOUT_ENV,
  RUNNER_READINESS_TIMEOUT_FLAG,
} from "../../utils/runnerReadinessConfig";
import {
  parseToolOutputsDirConfig,
  TOOL_OUTPUTS_DIR_FLAG,
  TOOL_OUTPUT_DIR_FLAG_ALIAS,
} from "../../utils/toolOutputArtifacts";
import { resolveDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";
import type { DaemonOptions } from "../types";

export function parseDaemonArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): DaemonOptions {
  const options: DaemonOptions = shouldSkipCtrlProxyDownload(args, env)
    ? { skipCtrlProxyDownload: true }
    : {};
  options.toolOutputsDir = parseToolOutputsDirConfig(
    [],
    env,
    resolveDaemonLaunchWorkingDirectory(),
  );
  const eventAllMarkers = parseEventAllMarkersConfig(args, env);
  const eventAllMarkersCliOverride = hasEventAllMarkersCliOverride(args);
  if (eventAllMarkers.length > 0 || eventAllMarkersCliOverride) {
    options.eventAllMarkers = eventAllMarkers;
    options.eventAllMarkersCliOverride = eventAllMarkersCliOverride;
  }
  const envRunnerReadinessTimeout = parseRunnerReadinessTimeout(
    env[RUNNER_READINESS_TIMEOUT_ENV] ?? env.AUTO_MOBILE_RUNNER_READINESS_TIMEOUT_MS,
  );
  if (envRunnerReadinessTimeout !== undefined) {
    options.runnerReadinessTimeoutMs = envRunnerReadinessTimeout;
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
      options.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--host") {
      const host = args[i + 1];
      if (host && !host.startsWith("--")) {
        options.host = host;
        i++;
      }
    } else if (args[i] === "--strict-port") {
      options.strictPort = true;
    } else if (args[i] === "--debug") {
      options.debug = true;
    } else if (args[i] === "--debug-perf" || args[i] === "--ui-perf-debug") {
      options.debugPerf = true;
    } else if (args[i] === "--plan-execution-lock-scope") {
      const scope = args[i + 1];
      if (scope === "global" || scope === "session") {
        options.planExecutionLockScope = scope;
        i++;
      }
    } else if (args[i] === RUNNER_READINESS_TIMEOUT_FLAG) {
      const timeoutMs = parseRunnerReadinessTimeout(args[i + 1]);
      if (timeoutMs !== undefined) {
        options.runnerReadinessTimeoutMs = timeoutMs;
        i++;
      }
    } else if (args[i] === "--video-quality" || args[i] === "--video-quality-preset") {
      options.videoQualityPreset = args[i + 1];
      i++;
    } else if (args[i] === "--video-target-bitrate-kbps") {
      options.videoTargetBitrateKbps = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--video-max-throughput-mbps") {
      options.videoMaxThroughputMbps = Number(args[i + 1]);
      i++;
    } else if (args[i] === "--video-fps") {
      options.videoFps = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--video-format") {
      options.videoFormat = args[i + 1];
      i++;
    } else if (args[i] === "--video-archive-size-mb") {
      options.videoMaxArchiveSizeMb = Number(args[i + 1]);
      i++;
    } else if (args[i] === TOOL_OUTPUTS_DIR_FLAG || args[i] === TOOL_OUTPUT_DIR_FLAG_ALIAS) {
      const toolOutputsDir = args[i + 1];
      if (toolOutputsDir && !toolOutputsDir.startsWith("--")) {
        options.toolOutputsDir = toolOutputsDir;
        i++;
      }
    } else if (args[i] === "--network-mockable") {
      options.networkMockable = true;
    } else if (args[i] === "--embedded-sdk") {
      options.embeddedSdk = true;
    } else if (args[i] === "--enable-tool") {
      const toolName = args[i + 1];
      if (toolName && !toolName.startsWith("--")) {
        options.enabledTools = [...(options.enabledTools ?? []), toolName];
        i++;
      }
    } else if (args[i] === "--disable-tool") {
      const toolName = args[i + 1];
      if (toolName && !toolName.startsWith("--")) {
        options.disabledTools = [...(options.disabledTools ?? []), toolName];
        i++;
      }
    } else if (args[i] === "--dismiss-keyboard-after-input") {
      options.dismissKeyboardAfterInput = true;
    } else if (args[i] === "--no-ui-perf-mode") {
      options.noUiPerfMode = true;
    } else if (args[i] === "--no-navigation-screenshots") {
      options.noNavigationScreenshots = true;
    } else if (args[i] === "--no-waitfor-polling-overhead") {
      options.noWaitForPollingOverhead = true;
    } else if (args[i] === "--no-occlusion") {
      options.noOcclusion = true;
    } else if (args[i] === "--no-include-not-important-views") {
      options.noA11yIncludeNotImportantViews = true;
    } else if (args[i] === "--no-report-view-ids") {
      options.noA11yReportViewIds = true;
    } else if (args[i] === "--no-retrieve-interactive-windows") {
      options.noA11yRetrieveInteractiveWindows = true;
    } else if (args[i] === "--mem-perf-audit") {
      options.memPerfAudit = true;
    } else if (args[i] === "--accessibility-audit") {
      options.accessibilityAudit = true;
    } else if (args[i] === "--accessibility-level" || args[i] === "--a11y-level") {
      options.accessibilityLevel = args[i + 1];
      i++;
    } else if (args[i] === "--accessibility-failure-mode" || args[i] === "--a11y-failure-mode") {
      options.accessibilityFailureMode = args[i + 1];
      i++;
    } else if (args[i] === "--accessibility-min-severity" || args[i] === "--a11y-min-severity") {
      options.accessibilityMinSeverity = args[i + 1];
      i++;
    } else if (args[i] === "--accessibility-use-baseline" || args[i] === "--a11y-use-baseline") {
      options.accessibilityUseBaseline = true;
    } else if (args[i] === "--predictive-ui" || args[i] === "--predictive") {
      options.predictiveUi = true;
    } else if (args[i] === "--raw-element-search") {
      options.rawElementSearch = true;
    } else if (
      args[i] === "--skip-ctrl-proxy-download" ||
      args[i] === "--skip-accessibility-download"
    ) {
      options.skipCtrlProxyDownload = true;
    } else if (args[i] === "--mcp-recording") {
      options.mcpRecording = true;
    } else if (args[i] === "--observe-result-include-elements") {
      options.observeResultIncludeElements = true;
    } else if (args[i] === "--tool-results-no-structured-content") {
      options.toolResultsNoStructuredContent = true;
    } else if (args[i] === "--actions-diff-observe") {
      options.actionsDiffObserve = true;
    } else if (args[i] === "--actions-no-observe") {
      options.actionsNoObserve = true;
    }
  }
  return options;
}
