import { parseArgs as parseNodeArgs } from "node:util";
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

export interface ParseLogger {
  warn(message: string): void;
}

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

const cliOptions = {
  ...booleanOptions,
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
  let daemonPort: number | undefined;
  let daemonHost: string | undefined;
  let initialSessionUuid: string | undefined;
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
  let a11yLevel: string | undefined;
  let a11yFailureMode: string | undefined;
  let a11yMinSeverity: string | undefined;
  let a11yUseBaseline = false;
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
  let runnerReadinessTimeoutMs = parsedRunnerReadinessEnv;
  if (runnerReadinessEnv !== undefined && parsedRunnerReadinessEnv === undefined) {
    log.warn(
      `Invalid ${RUNNER_READINESS_TIMEOUT_ENV}: ${runnerReadinessEnv}; expected an integer ` +
        `from ${MIN_RUNNER_READINESS_TIMEOUT_MS} to ${MAX_RUNNER_READINESS_TIMEOUT_MS}`,
    );
  }
  let planExecutionLockScope: PlanExecutionLockScope = "session";
  const videoRecordingDefaults: VideoRecordingConfigInput = {};

  const parsePositiveNumber = (
    value: string | undefined,
    label: string,
    allowFloat: boolean,
  ): number | undefined => {
    if (!value) {
      return undefined;
    }
    const parsed = allowFloat ? Number(value) : parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      log.warn(`Invalid ${label}: ${value}`);
      return undefined;
    }
    return allowFloat ? parsed : Math.round(parsed);
  };
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
  const envNumbers: Array<[string | undefined, string, boolean, keyof VideoRecordingConfigInput]> =
    [
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
    const parsed = parsePositiveNumber(value, label, allowFloat);
    if (parsed !== undefined) {
      videoRecordingDefaults[key] = parsed as never;
    }
  }
  applyFormat(process.env.AUTOMOBILE_VIDEO_FORMAT ?? process.env.AUTO_MOBILE_VIDEO_FORMAT, "env");

  const cliIndex = args.indexOf("--cli");
  const cliArgs = cliMode ? args.slice(cliIndex + 1) : [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--cli") {
      break;
    }
    if (arg === "--port") {
      const nextArg = args[i + 1];
      const port = parseInt(nextArg, 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        daemonPort = port;
        i++;
      } else {
        log.warn(`Invalid port: ${nextArg}`);
      }
    } else if (arg === "--host") {
      const host = args[i + 1];
      if (host && !host.startsWith("--")) {
        daemonHost = host;
        i++;
      } else {
        log.warn(`Invalid host: ${host}`);
      }
    } else if (arg === "--initial-session-uuid") {
      const sessionUuid = args[i + 1];
      if (sessionUuid && !sessionUuid.startsWith("--")) {
        initialSessionUuid = sessionUuid;
        i++;
      } else {
        log.warn(`Invalid initial session UUID: ${sessionUuid}`);
      }
    } else if (arg === "--a11y-level") {
      a11yLevel = args[++i];
    } else if (arg === "--a11y-failure-mode") {
      a11yFailureMode = args[++i];
    } else if (arg === "--a11y-min-severity") {
      a11yMinSeverity = args[++i];
    } else if (arg === "--a11y-use-baseline") {
      a11yUseBaseline = true;
    } else if (arg === "--plan-execution-lock-scope") {
      const scope = args[++i];
      if (scope === "global" || scope === "session") {
        planExecutionLockScope = scope;
      } else {
        log.warn(
          `Invalid plan execution lock scope: ${scope}. Using default: ${planExecutionLockScope}`,
        );
      }
    } else if (arg === RUNNER_READINESS_TIMEOUT_FLAG) {
      const raw = args[++i];
      const parsed = parseRunnerReadinessTimeout(raw);
      if (parsed !== undefined) {
        runnerReadinessTimeoutMs = parsed;
      } else {
        log.warn(
          `Invalid runner readiness timeout: ${raw}; expected an integer from ` +
            `${MIN_RUNNER_READINESS_TIMEOUT_MS} to ${MAX_RUNNER_READINESS_TIMEOUT_MS}`,
        );
      }
    } else if (arg === "--video-quality" || arg === "--video-quality-preset") {
      applyQualityPreset(args[++i], "cli");
    } else if (arg === "--video-target-bitrate-kbps") {
      const value = parsePositiveNumber(args[++i], "video target bitrate", false);
      if (value !== undefined) {
        videoRecordingDefaults.targetBitrateKbps = value;
      }
    } else if (arg === "--video-max-throughput-mbps") {
      const value = parsePositiveNumber(args[++i], "video max throughput", true);
      if (value !== undefined) {
        videoRecordingDefaults.maxThroughputMbps = value;
      }
    } else if (arg === "--video-fps") {
      const value = parsePositiveNumber(args[++i], "video fps", false);
      if (value !== undefined) {
        videoRecordingDefaults.fps = value;
      }
    } else if (arg === "--video-format") {
      applyFormat(args[++i], "cli");
    } else if (arg === "--video-archive-size-mb") {
      const value = parsePositiveNumber(args[++i], "video max archive size", true);
      if (value !== undefined) {
        videoRecordingDefaults.maxArchiveSizeMb = value;
      }
    }
  }
  return {
    cliMode,
    cliArgs,
    daemonPort,
    daemonHost,
    initialSessionUuid,
    debugPerf,
    debug,
    strictPort,
    uiPerfMode,
    memPerfAuditMode,
    a11yAuditMode,
    a11yLevel,
    a11yFailureMode,
    a11yMinSeverity,
    a11yUseBaseline,
    predictiveUi,
    rawElementSearch,
    planExecutionLockScope,
    videoRecordingDefaults,
    runnerReadinessTimeoutMs,
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
