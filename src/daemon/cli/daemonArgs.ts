import { parsePort, parsePositiveNumber, type ParseLogger } from "../../cli/numericValidators";
import { logger } from "../../utils/logger";
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

const numericFlags: Partial<
  Record<
    string,
    {
      field:
        | "videoTargetBitrateKbps"
        | "videoMaxThroughputMbps"
        | "videoFps"
        | "videoMaxArchiveSizeMb";
      label: string;
      allowFloat: boolean;
    }
  >
> = {
  "--video-target-bitrate-kbps": {
    field: "videoTargetBitrateKbps",
    label: "video target bitrate",
    allowFloat: false,
  },
  "--video-max-throughput-mbps": {
    field: "videoMaxThroughputMbps",
    label: "video max throughput",
    allowFloat: true,
  },
  "--video-fps": { field: "videoFps", label: "video fps", allowFloat: false },
  "--video-archive-size-mb": {
    field: "videoMaxArchiveSizeMb",
    label: "video max archive size",
    allowFloat: true,
  },
};

const stringFlags: Partial<
  Record<
    string,
    | "videoQualityPreset"
    | "videoFormat"
    | "accessibilityLevel"
    | "accessibilityFailureMode"
    | "accessibilityMinSeverity"
  >
> = {
  "--video-quality": "videoQualityPreset",
  "--video-quality-preset": "videoQualityPreset",
  "--video-format": "videoFormat",
  "--accessibility-level": "accessibilityLevel",
  "--a11y-level": "accessibilityLevel",
  "--accessibility-failure-mode": "accessibilityFailureMode",
  "--a11y-failure-mode": "accessibilityFailureMode",
  "--accessibility-min-severity": "accessibilityMinSeverity",
  "--a11y-min-severity": "accessibilityMinSeverity",
};

export function parseDaemonArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  log: ParseLogger = logger,
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
  // --daemon-socket-path=<encoded path> is a discovery marker, intentionally
  // ignored here: the manager forwards the authoritative namespace through ENV.
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    const hasValue = value !== undefined && !value.startsWith("--");
    const numericFlag = Object.hasOwn(numericFlags, args[i]) ? numericFlags[args[i]] : undefined;
    const stringField = Object.hasOwn(stringFlags, args[i]) ? stringFlags[args[i]] : undefined;
    if (numericFlag) {
      options[numericFlag.field] = parsePositiveNumber(
        value,
        numericFlag.label,
        numericFlag.allowFloat,
        log,
      );
      if (hasValue) {
        i++;
      }
    } else if (stringField) {
      if (hasValue) {
        options[stringField] = value;
        i++;
      }
    } else if (args[i] === "--port") {
      options.port = parsePort(value, log);
      if (hasValue) {
        i++;
      }
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
