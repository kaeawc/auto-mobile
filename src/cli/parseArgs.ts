import { parseArgs as parseNodeArgs } from "node:util";
import { parsePort, parsePositiveNumber, type ParseLogger } from "./numericValidators";
import type { VideoRecordingConfigInput } from "../models";
import type { PlanExecutionLockScope } from "../utils/ServerConfig";
import { shouldSkipCtrlProxyDownload } from "../utils/ctrlProxyDownloadControl";
import {
  hasEventAllMarkersCliOverride,
  parseEventAllMarkersConfig,
} from "../utils/eventAllMarkers";
import { parseOutputReductionFlags } from "../utils/outputReductionFlags";
import { parseToolOutputsDirConfig } from "../utils/toolOutputArtifacts";
import { resolveDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";
import {
  MAX_RUNNER_READINESS_TIMEOUT_MS,
  MIN_RUNNER_READINESS_TIMEOUT_MS,
  RUNNER_READINESS_TIMEOUT_ENV,
  RUNNER_READINESS_TIMEOUT_FLAG,
  parseRunnerReadinessTimeout,
} from "../utils/runnerReadinessConfig";

export type { ParseLogger } from "./numericValidators";

type CliVideoRecordingNumericKey =
  | "targetBitrateKbps"
  | "maxThroughputMbps"
  | "fps"
  | "maxArchiveSizeMb";

export type CliVideoRecordingDefaults = Omit<
  VideoRecordingConfigInput,
  CliVideoRecordingNumericKey
> &
  Partial<Record<CliVideoRecordingNumericKey, number>>;

const booleanOptions = Object.fromEntries(
  [
    "cli",
    "daemon-mode",
    "no-proxy",
    "direct",
    "no-daemon",
    "debug-perf",
    "ui-perf-debug",
    "debug",
    "no-ui-perf-mode",
    "mem-perf-audit",
    "accessibility-audit",
    "predictive",
    "predictive-ui",
    "raw-element-search",
    "embedded-sdk",
    "network-mockable",
    "dismiss-keyboard-after-input",
    "mcp-recording",
    "no-navigation-screenshots",
    "no-waitfor-polling-overhead",
    "no-include-not-important-views",
    "no-report-view-ids",
    "no-retrieve-interactive-windows",
    "no-occlusion",
    "strict-port",
  ].map((name) => [name, { type: "boolean" as const }]),
);

export const cliOptions = {
  ...booleanOptions,
  // Process-discovery marker only; namespace paths still come from launch ENV.
  "daemon-socket-path": { type: "string" as const },
  "enable-tool": { type: "string" as const, multiple: true },
  "disable-tool": { type: "string" as const, multiple: true },
};

/** Parses daemon options from explicit argument tokens, rather than process.argv. */
// The existing option surface is intentionally preserved during this extraction.
// A declarative parser migration is separate behavior-changing work.
// eslint-disable-next-line complexity
export function parseArgs(
  args: string[],
  log: ParseLogger,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const { values } = parseNodeArgs({
    args,
    options: cliOptions,
    allowPositionals: true,
    strict: false,
  });
  // `=== true` intentionally retains the prior exact-flag behavior for
  // `--flag=value` while delegating ordinary flag tokenization to Node/Bun.
  const hasFlag = (name: string) => values[name] === true;
  const { enabledTools, disabledTools } = parseToolDefaults(values, environment);
  const cliMode = hasFlag("cli");
  const daemonMode = hasFlag("daemon-mode");
  const noProxy = hasFlag("no-proxy") || hasFlag("direct");
  const noDaemon = hasFlag("no-daemon");
  const daemonCommandIndex = args.indexOf("--daemon");
  const daemonCommand = daemonCommandIndex >= 0 ? args[daemonCommandIndex + 1] : undefined;
  const daemonArgs = daemonCommandIndex >= 0 ? args.slice(daemonCommandIndex + 2) : [];
  const debugPerf =
    hasFlag("debug-perf") || hasFlag("ui-perf-debug") || process.env.AUTOMOBILE_DEBUG_PERF === "1";
  const debug = hasFlag("debug") || process.env.AUTOMOBILE_DEBUG === "1";
  const strictPort = hasFlag("strict-port");
  const uiPerfMode = !hasFlag("no-ui-perf-mode");
  const memPerfAuditMode = hasFlag("mem-perf-audit");
  const a11yAuditMode = hasFlag("accessibility-audit");
  const predictiveUi = hasFlag("predictive") || hasFlag("predictive-ui");
  const rawElementSearch = hasFlag("raw-element-search");
  const skipCtrlProxyDownload = shouldSkipCtrlProxyDownload(args);
  const embeddedSdk = hasFlag("embedded-sdk");
  const networkMockable = hasFlag("network-mockable");
  const dismissKeyboardAfterInput = hasFlag("dismiss-keyboard-after-input");
  const eventAllMarkers = parseEventAllMarkersConfig(args, process.env);
  const eventAllMarkersCliOverride = hasEventAllMarkersCliOverride(args);
  const mcpRecording = hasFlag("mcp-recording");
  const navigationScreenshots = !hasFlag("no-navigation-screenshots");
  const noWaitForPollingOverhead = hasFlag("no-waitfor-polling-overhead");
  const noA11yIncludeNotImportantViews = hasFlag("no-include-not-important-views");
  const noA11yReportViewIds = hasFlag("no-report-view-ids");
  const noA11yRetrieveInteractiveWindows = hasFlag("no-retrieve-interactive-windows");
  const noOcclusion = hasFlag("no-occlusion");
  const outputReduction = parseOutputReductionFlags(args, process.env);
  const toolOutputsDir = parseToolOutputsDirConfig(
    args,
    process.env,
    resolveDaemonLaunchWorkingDirectory(),
  );
  const runnerReadinessEnv =
    environment[RUNNER_READINESS_TIMEOUT_ENV] ??
    environment.AUTO_MOBILE_RUNNER_READINESS_TIMEOUT_MS;
  const parsedRunnerReadinessEnv = parseRunnerReadinessTimeout(runnerReadinessEnv);
  // Undefined means this client has no opinion about a running daemon's
  // readiness budget. The daemon's ServerConfig owns the product default.
  const runnerReadinessTimeoutMs = parsedRunnerReadinessEnv;
  if (runnerReadinessEnv !== undefined && parsedRunnerReadinessEnv === undefined) {
    log.warn(
      `Invalid ${RUNNER_READINESS_TIMEOUT_ENV}: ${runnerReadinessEnv}; expected an integer ` +
        `from ${MIN_RUNNER_READINESS_TIMEOUT_MS} to ${MAX_RUNNER_READINESS_TIMEOUT_MS}`,
    );
  }
  const video = createVideoRecordingDefaults(log);
  const { videoRecordingDefaults } = video;

  const cliIndex = args.indexOf("--cli");
  const cliArgs = cliMode ? args.slice(cliIndex + 1) : [];
  const scalarOptions = parseValueOptions(args, log, video, runnerReadinessTimeoutMs);

  return {
    cliMode,
    cliArgs,
    daemonPort: scalarOptions.daemonPort,
    daemonHost: scalarOptions.daemonHost,
    initialSessionUuid: scalarOptions.initialSessionUuid,
    livenessOwnerToken: scalarOptions.livenessOwnerToken,
    debugPerf,
    debug,
    strictPort,
    uiPerfMode,
    memPerfAuditMode,
    a11yAuditMode,
    a11yLevel: scalarOptions.a11yLevel,
    a11yFailureMode: scalarOptions.a11yFailureMode,
    a11yMinSeverity: scalarOptions.a11yMinSeverity,
    a11yUseBaseline: scalarOptions.a11yUseBaseline,
    predictiveUi,
    rawElementSearch,
    planExecutionLockScope: scalarOptions.planExecutionLockScope,
    planExecutionLockScopeExplicit: scalarOptions.planExecutionLockScopeExplicit,
    videoRecordingDefaults,
    runnerReadinessTimeoutMs: scalarOptions.runnerReadinessTimeoutMs,
    daemonMode,
    daemonCommand,
    daemonArgs,
    skipCtrlProxyDownload,
    embeddedSdk,
    networkMockable,
    dismissKeyboardAfterInput,
    eventAllMarkers,
    eventAllMarkersCliOverride,
    mcpRecording,
    navigationScreenshots,
    noWaitForPollingOverhead,
    noProxy,
    noDaemon,
    noA11yIncludeNotImportantViews,
    noA11yReportViewIds,
    noA11yRetrieveInteractiveWindows,
    noOcclusion,
    outputReduction,
    toolOutputsDir,
    enabledTools,
    disabledTools,
  };
}

function parseToolDefaults(
  values: ReturnType<typeof parseNodeArgs>["values"],
  environment: NodeJS.ProcessEnv,
): { enabledTools: string[]; disabledTools: string[] } {
  const retiredToolsetVariable = Object.keys(environment).find((name) =>
    name.startsWith("AUTOMOBILE_TOOLSET_"),
  );
  if (retiredToolsetVariable) {
    throw new Error(
      `${retiredToolsetVariable} is retired; use AUTOMOBILE_ENABLED_TOOLS or AUTOMOBILE_DISABLED_TOOLS.`,
    );
  }
  const stringValues = (name: string): string[] => {
    const value = values[name];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }
    return typeof value === "string" ? [value] : [];
  };
  const cliEnabledTools = Array.from(new Set(stringValues("enable-tool")));
  const cliDisabledTools = Array.from(new Set(stringValues("disable-tool")));
  const cliDisabledToolSet = new Set(cliDisabledTools);
  const conflictingTool = cliEnabledTools.find((toolName) => cliDisabledToolSet.has(toolName));
  if (conflictingTool) {
    throw new Error(
      `Tool '${conflictingTool}' cannot be both enabled and disabled by CLI defaults.`,
    );
  }
  const parseEnvironmentTools = (raw: string | undefined) =>
    raw
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  const environmentEnabledTools = parseEnvironmentTools(environment.AUTOMOBILE_ENABLED_TOOLS);
  const environmentDisabledTools = parseEnvironmentTools(environment.AUTOMOBILE_DISABLED_TOOLS);
  const environmentDisabledSet = new Set(environmentDisabledTools);
  const environmentConflict = environmentEnabledTools.find((toolName) =>
    environmentDisabledSet.has(toolName),
  );
  if (environmentConflict) {
    throw new Error(
      `Tool '${environmentConflict}' cannot be both enabled and disabled by environment defaults.`,
    );
  }
  const effectiveToolDefaults = new Map<string, boolean>([
    ...environmentEnabledTools.map((toolName) => [toolName, true] as const),
    ...environmentDisabledTools.map((toolName) => [toolName, false] as const),
    ...cliEnabledTools.map((toolName) => [toolName, true] as const),
    ...cliDisabledTools.map((toolName) => [toolName, false] as const),
  ]);
  const enabledTools = Array.from(effectiveToolDefaults)
    .filter(([, enabled]) => enabled)
    .map(([toolName]) => toolName);
  const disabledTools = Array.from(effectiveToolDefaults)
    .filter(([, enabled]) => !enabled)
    .map(([toolName]) => toolName);

  return { enabledTools, disabledTools };
}

function createVideoRecordingDefaults(log: ParseLogger) {
  const videoRecordingDefaults: CliVideoRecordingDefaults = {};

  const applyQualityPreset = (value: string | undefined, source: string) => {
    if (!value) {
      return;
    }
    if (!new Set(["low", "medium", "high"]).has(value)) {
      log.warn(`Invalid video quality preset (${source}): ${value}`);
      return;
    }
    videoRecordingDefaults.qualityPreset = value;
  };
  const applyFormat = (value: string | undefined, source: string) => {
    if (!value) {
      return;
    }
    if (value !== "mp4") {
      log.warn(`Invalid video format (${source}): ${value}`);
      return;
    }
    videoRecordingDefaults.format = value;
  };

  applyQualityPreset(
    process.env.AUTOMOBILE_VIDEO_QUALITY_PRESET ?? process.env.AUTO_MOBILE_VIDEO_QUALITY_PRESET,
    "env",
  );
  const envNumbers: Array<[string | undefined, string, boolean, CliVideoRecordingNumericKey]> = [
    [
      process.env.AUTOMOBILE_VIDEO_TARGET_BITRATE_KBPS ??
        process.env.AUTO_MOBILE_VIDEO_TARGET_BITRATE_KBPS,
      "video target bitrate",
      false,
      "targetBitrateKbps",
    ],
    [
      process.env.AUTOMOBILE_VIDEO_MAX_THROUGHPUT_MBPS ??
        process.env.AUTO_MOBILE_VIDEO_MAX_THROUGHPUT_MBPS,
      "video max throughput",
      true,
      "maxThroughputMbps",
    ],
    [
      process.env.AUTOMOBILE_VIDEO_FPS ?? process.env.AUTO_MOBILE_VIDEO_FPS,
      "video fps",
      false,
      "fps",
    ],
    [
      process.env.AUTOMOBILE_VIDEO_MAX_ARCHIVE_MB ?? process.env.AUTO_MOBILE_VIDEO_MAX_ARCHIVE_MB,
      "video max archive size",
      true,
      "maxArchiveSizeMb",
    ],
  ];
  for (const [value, label, allowFloat, key] of envNumbers) {
    const parsed = parsePositiveNumber(value, label, allowFloat, log);
    if (parsed !== undefined) {
      videoRecordingDefaults[key] = parsed;
    }
  }
  applyFormat(process.env.AUTOMOBILE_VIDEO_FORMAT ?? process.env.AUTO_MOBILE_VIDEO_FORMAT, "env");

  return { videoRecordingDefaults, applyQualityPreset, applyFormat };
}

interface ScalarOptions {
  daemonPort?: number;
  daemonHost?: string;
  initialSessionUuid?: string;
  livenessOwnerToken?: string;
  a11yLevel?: string;
  a11yFailureMode?: string;
  a11yMinSeverity?: string;
  a11yUseBaseline: boolean;
  planExecutionLockScope: PlanExecutionLockScope;
  planExecutionLockScopeExplicit: boolean;
  runnerReadinessTimeoutMs?: number;
}

function parseValueOptions(
  args: string[],
  log: ParseLogger,
  video: ReturnType<typeof createVideoRecordingDefaults>,
  runnerReadinessTimeoutMs: number | undefined,
): ScalarOptions {
  const options: ScalarOptions = {
    a11yUseBaseline: false,
    planExecutionLockScope: "session",
    planExecutionLockScopeExplicit: false,
    runnerReadinessTimeoutMs,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cli") {
      break;
    }
    const connection = parseConnectionOption(args, i, log, options);
    if (connection !== undefined) {
      i = connection;
      continue;
    }
    const accessibility = parseAccessibilityOption(args, i, log, options);
    if (accessibility !== undefined) {
      i = accessibility;
      continue;
    }
    const readiness = parseReadinessOption(args, i, log, options);
    if (readiness !== undefined) {
      i = readiness;
      continue;
    }
    const recording = parseVideoOption(args, i, log, video);
    if (recording !== undefined) {
      i = recording;
    }
  }
  return options;
}

function parseConnectionOption(
  args: string[],
  i: number,
  log: ParseLogger,
  options: ScalarOptions,
): number | undefined {
  const arg = args[i];
  if (arg === "--port") {
    const nextArg = args[i + 1];
    const port = parsePort(nextArg, log);
    if (port !== undefined) {
      options.daemonPort = port;
      i++;
    }
  } else if (arg === "--host") {
    const host = args[i + 1];
    if (host && !host.startsWith("--")) {
      options.daemonHost = host;
      i++;
    } else {
      log.warn(`Invalid host: ${host}`);
    }
  } else {
    return parseSessionBindingOption(args, i, log, options);
  }
  return i;
}

/** The proxy's device-session binding flags: which session, and under which owner token. */
function parseSessionBindingOption(
  args: string[],
  i: number,
  log: ParseLogger,
  options: ScalarOptions,
): number | undefined {
  const arg = args[i];
  const value = args[i + 1]?.trim();
  const hasValue = value !== undefined && value.length > 0 && !value.startsWith("--");
  if (arg === "--initial-session-uuid") {
    if (!hasValue) {
      log.warn(`Invalid initial session UUID: ${args[i + 1]}`);
      return i;
    }
    options.initialSessionUuid = args[i + 1];
    return i + 1;
  }
  if (arg === "--liveness-owner-token") {
    if (!hasValue) {
      log.warn("--liveness-owner-token requires a non-empty value");
      return i;
    }
    options.livenessOwnerToken = value;
    return i + 1;
  }
  return undefined;
}

function parseAccessibilityOption(
  args: string[],
  i: number,
  log: ParseLogger,
  options: ScalarOptions,
): number | undefined {
  const arg = args[i];
  if (arg === "--a11y-level") {
    options.a11yLevel = args[++i];
  } else if (arg === "--a11y-failure-mode") {
    options.a11yFailureMode = args[++i];
  } else if (arg === "--a11y-min-severity") {
    options.a11yMinSeverity = args[++i];
  } else if (arg === "--a11y-use-baseline") {
    options.a11yUseBaseline = true;
  } else {
    return undefined;
  }
  return i;
}

function parseReadinessOption(
  args: string[],
  i: number,
  log: ParseLogger,
  options: ScalarOptions,
): number | undefined {
  const arg = args[i];
  if (arg === "--plan-execution-lock-scope") {
    const scope = args[++i];
    if (scope === "global" || scope === "session") {
      options.planExecutionLockScope = scope;
      options.planExecutionLockScopeExplicit = true;
    } else {
      log.warn(
        `Invalid plan execution lock scope: ${scope}. Using default: ${options.planExecutionLockScope}`,
      );
    }
  } else if (arg === RUNNER_READINESS_TIMEOUT_FLAG) {
    const raw = args[++i];
    const parsed = parseRunnerReadinessTimeout(raw);
    if (parsed !== undefined) {
      options.runnerReadinessTimeoutMs = parsed;
    } else {
      log.warn(
        `Invalid runner readiness timeout: ${raw}; expected an integer from ` +
          `${MIN_RUNNER_READINESS_TIMEOUT_MS} to ${MAX_RUNNER_READINESS_TIMEOUT_MS}`,
      );
    }
  } else {
    return undefined;
  }
  return i;
}

function parseVideoOption(
  args: string[],
  i: number,
  log: ParseLogger,
  video: ReturnType<typeof createVideoRecordingDefaults>,
): number | undefined {
  const arg = args[i];
  const { videoRecordingDefaults, applyQualityPreset, applyFormat } = video;
  if (arg === "--video-quality" || arg === "--video-quality-preset") {
    applyQualityPreset(args[++i], "cli");
  } else if (arg === "--video-target-bitrate-kbps") {
    applyVideoNumber(
      videoRecordingDefaults,
      args[++i],
      "video target bitrate",
      false,
      "targetBitrateKbps",
      log,
    );
  } else if (arg === "--video-max-throughput-mbps") {
    applyVideoNumber(
      videoRecordingDefaults,
      args[++i],
      "video max throughput",
      true,
      "maxThroughputMbps",
      log,
    );
  } else if (arg === "--video-fps") {
    applyVideoNumber(videoRecordingDefaults, args[++i], "video fps", false, "fps", log);
  } else if (arg === "--video-format") {
    applyFormat(args[++i], "cli");
  } else if (arg === "--video-archive-size-mb") {
    applyVideoNumber(
      videoRecordingDefaults,
      args[++i],
      "video max archive size",
      true,
      "maxArchiveSizeMb",
      log,
    );
  } else {
    return undefined;
  }
  return i;
}

function applyVideoNumber(
  defaults: CliVideoRecordingDefaults,
  raw: string | undefined,
  label: string,
  allowFloat: boolean,
  key: CliVideoRecordingNumericKey,
  log: ParseLogger,
): void {
  const value = parsePositiveNumber(raw, label, allowFloat, log);
  if (value !== undefined) {
    defaults[key] = value;
  }
}
