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
import { parseOutputReductionFlags } from "../../utils/outputReductionFlags";
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

type DaemonBooleanOption = {
  [Key in keyof DaemonOptions]-?: DaemonOptions[Key] extends boolean | undefined ? Key : never;
}[keyof DaemonOptions];

const booleanFlags: Partial<Record<string, DaemonBooleanOption>> = {
  "--strict-port": "strictPort",
  "--debug": "debug",
  "--debug-perf": "debugPerf",
  "--ui-perf-debug": "debugPerf",
  "--network-mockable": "networkMockable",
  "--embedded-sdk": "embeddedSdk",
  "--dismiss-keyboard-after-input": "dismissKeyboardAfterInput",
  "--no-ui-perf-mode": "noUiPerfMode",
  "--no-navigation-screenshots": "noNavigationScreenshots",
  "--no-waitfor-polling-overhead": "noWaitForPollingOverhead",
  "--no-occlusion": "noOcclusion",
  "--no-include-not-important-views": "noA11yIncludeNotImportantViews",
  "--no-report-view-ids": "noA11yReportViewIds",
  "--no-retrieve-interactive-windows": "noA11yRetrieveInteractiveWindows",
  "--mem-perf-audit": "memPerfAudit",
  "--accessibility-audit": "accessibilityAudit",
  "--accessibility-use-baseline": "accessibilityUseBaseline",
  "--a11y-use-baseline": "accessibilityUseBaseline",
  "--predictive-ui": "predictiveUi",
  "--predictive": "predictiveUi",
  "--raw-element-search": "rawElementSearch",
  "--skip-ctrl-proxy-download": "skipCtrlProxyDownload",
  "--skip-accessibility-download": "skipCtrlProxyDownload",
  "--mcp-recording": "mcpRecording",
  "--observe-result-include-elements": "observeResultIncludeElements",
  "--tool-results-no-structured-content": "toolResultsNoStructuredContent",
  "--actions-diff-observe": "actionsDiffObserve",
  "--actions-no-observe": "actionsNoObserve",
};

function hasDaemonFlagValue(value: string | undefined): value is string {
  return value !== undefined && !value.startsWith("--");
}

function setDaemonHost(options: DaemonOptions, value: string | undefined): boolean {
  if (!value || value.startsWith("--")) {
    return false;
  }
  options.host = value;
  return true;
}

function setDaemonLockScope(options: DaemonOptions, value: string | undefined): boolean {
  if (value !== "global" && value !== "session") {
    return false;
  }
  options.planExecutionLockScope = value;
  return true;
}

function setDaemonReadinessTimeout(options: DaemonOptions, value: string | undefined): boolean {
  const timeoutMs = parseRunnerReadinessTimeout(value);
  if (timeoutMs === undefined) {
    return false;
  }
  options.runnerReadinessTimeoutMs = timeoutMs;
  return true;
}

function setDaemonToolOutputsDir(options: DaemonOptions, value: string | undefined): boolean {
  if (!value || value.startsWith("--")) {
    return false;
  }
  options.toolOutputsDir = value;
  return true;
}

function appendDaemonTool(
  options: DaemonOptions,
  value: string | undefined,
  field: "enabledTools" | "disabledTools",
): boolean {
  if (!value || value.startsWith("--")) {
    return false;
  }
  options[field] = [...(options[field] ?? []), value];
  return true;
}

const valueFlags: Partial<
  Record<string, (options: DaemonOptions, value: string | undefined) => boolean>
> = {
  "--host": setDaemonHost,
  "--plan-execution-lock-scope": setDaemonLockScope,
  [RUNNER_READINESS_TIMEOUT_FLAG]: setDaemonReadinessTimeout,
  [TOOL_OUTPUTS_DIR_FLAG]: setDaemonToolOutputsDir,
  [TOOL_OUTPUT_DIR_FLAG_ALIAS]: setDaemonToolOutputsDir,
  "--enable-tool": (options, value) => appendDaemonTool(options, value, "enabledTools"),
  "--disable-tool": (options, value) => appendDaemonTool(options, value, "disabledTools"),
};

function consumeDaemonFlag(
  flag: string,
  value: string | undefined,
  options: DaemonOptions,
  log: ParseLogger,
): boolean {
  const numericFlag = Object.hasOwn(numericFlags, flag) ? numericFlags[flag] : undefined;
  if (numericFlag) {
    options[numericFlag.field] = parsePositiveNumber(
      value,
      numericFlag.label,
      numericFlag.allowFloat,
      log,
    );
    return hasDaemonFlagValue(value);
  }
  const stringField = Object.hasOwn(stringFlags, flag) ? stringFlags[flag] : undefined;
  if (stringField) {
    if (!hasDaemonFlagValue(value)) {
      return false;
    }
    options[stringField] = value;
    return true;
  }
  if (flag === "--port") {
    options.port = parsePort(value, log);
    return hasDaemonFlagValue(value);
  }
  const valueFlag = Object.hasOwn(valueFlags, flag) ? valueFlags[flag] : undefined;
  if (valueFlag) {
    return valueFlag(options, value);
  }
  const booleanField = Object.hasOwn(booleanFlags, flag) ? booleanFlags[flag] : undefined;
  if (booleanField) {
    options[booleanField] = true;
  }
  return false;
}

export function parseDaemonArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  log: ParseLogger = logger,
): DaemonOptions {
  const options: DaemonOptions = shouldSkipCtrlProxyDownload(args, env)
    ? { skipCtrlProxyDownload: true }
    : {};
  options.actionsCompactMetadata = parseOutputReductionFlags(args, env).actionsCompactMetadata;
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
    if (consumeDaemonFlag(args[i], args[i + 1], options, log)) {
      i++;
    }
  }
  return options;
}
