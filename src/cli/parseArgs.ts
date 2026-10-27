import { readFileSync } from "node:fs";
import { parseArgs as parseNodeArgs } from "node:util";
import { parsePort, parsePositiveNumber, type ParseLogger } from "./numericValidators";
import { parseBooleanFlagValue, splitFlagToken } from "../utils/flagTokens";
import type { VideoRecordingConfigInput } from "../models";
import {
  SESSION_CONFIG_ENV,
  SESSION_CONFIG_FLAG,
  SessionConfigError,
  resolveSessionConfig,
} from "../devices/sessionConfig";
import type { PlanExecutionLockScope } from "../utils/ServerConfig";
import { shouldSkipCtrlProxyDownload } from "../utils/ctrlProxyDownloadControl";
import {
  EVENT_ALL_MARKERS_FLAG,
  hasEventAllMarkersCliOverride,
  parseEventAllMarkersConfig,
} from "../utils/eventAllMarkers";
import {
  OUTPUT_REDUCTION_FLAG_SPECS,
  parseOutputReductionFlags,
} from "../utils/outputReductionFlags";
import {
  parseToolOutputsDirConfig,
  TOOL_OUTPUTS_DIR_FLAG,
  TOOL_OUTPUT_DIR_FLAG_ALIAS,
} from "../utils/toolOutputArtifacts";
import { resolveDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";
import {
  MAX_RUNNER_READINESS_TIMEOUT_MS,
  MIN_RUNNER_READINESS_TIMEOUT_MS,
  RUNNER_READINESS_TIMEOUT_ENV,
  RUNNER_READINESS_TIMEOUT_FLAG,
  parseRunnerReadinessTimeout,
} from "../utils/runnerReadinessConfig";
import { ENV, isRetiredToolsetVariable, readEnvBool, readEnvRaw } from "../config/env";

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
    "tool-call-recording",
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
  // Process-discovery marker only; namespace paths still come from launch ENV.
  "daemon-socket-path": { type: "string" as const },
  "enable-tool": { type: "string" as const, multiple: true },
  "disable-tool": { type: "string" as const, multiple: true },
};

// Value-taking options resolved outside the scalar-option walk below.
const externalValueFlags = [
  ...Object.entries(cliOptions)
    .filter(([, option]) => option.type === "string")
    .map(([name]) => `--${name}`),
  EVENT_ALL_MARKERS_FLAG,
  TOOL_OUTPUTS_DIR_FLAG,
  TOOL_OUTPUT_DIR_FLAG_ALIAS,
];

/** Parses daemon options from explicit argument tokens, rather than process.argv. */
// The existing option surface is intentionally preserved during this extraction.
// A declarative parser migration is separate behavior-changing work.
export function parseArgs(
  args: string[],
  log: ParseLogger,
  environment: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
) {
  const { values } = parseNodeArgs({
    args,
    options: cliOptions,
    allowPositionals: true,
    strict: false,
  });
  // Node's parser reports `--flag=value` on a boolean as the string; read it the way every
  // other boolean flag is read (`--flag`/`--flag=true` on, `--flag=false` off, else warned).
  const hasFlag = (name: string) => {
    const value = values[name];
    if (value === undefined) {
      return false;
    }
    const enabled = value === true ? true : parseBooleanFlagValue(String(value));
    if (enabled === undefined) {
      log.warn(`Invalid value for --${name}: ${String(value)}; expected true or false`);
    }
    return enabled === true;
  };
  const { enabledTools, disabledTools } = parseToolDefaults(values, environment);
  const cliMode = hasFlag("cli");
  const daemonMode = hasFlag("daemon-mode");
  const noProxy = hasFlag("no-proxy") || hasFlag("direct");
  const noDaemon = hasFlag("no-daemon");
  const { daemonRequested, daemonCommand, daemonArgs } = parseDaemonCommand(args);
  const debugPerf =
    hasFlag("debug-perf") || hasFlag("ui-perf-debug") || readEnvBool(ENV.DEBUG_PERF, environment);
  const debug = hasFlag("debug") || readEnvBool(ENV.DEBUG, environment);
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
  const toolCallRecording = hasFlag("tool-call-recording");
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
  const runnerReadinessTimeoutMs = parseReadinessEnvironment(environment, log);
  const video = createVideoRecordingDefaults(log);
  const { videoRecordingDefaults } = video;

  const cliIndex = args.indexOf("--cli");
  const cliArgs = cliMode ? args.slice(cliIndex + 1) : [];
  const scalarOptions = parseValueOptions(args, log, video, runnerReadinessTimeoutMs);
  const sessionConfig = resolveSessionConfig({
    flagValue: scalarOptions.sessionConfigValue,
    envValue:
      cliMode || daemonMode || daemonRequested ? undefined : environment[SESSION_CONFIG_ENV],
    readFile,
    hasInitialSessionUuid: scalarOptions.initialSessionUuid !== undefined,
    noProxy,
  });

  return {
    cliMode,
    cliArgs,
    invalidInvocation: scalarOptions.invalidInvocation,
    daemonPort: scalarOptions.daemonPort,
    daemonHost: scalarOptions.daemonHost,
    initialSessionUuid: scalarOptions.initialSessionUuid,
    livenessOwnerToken: scalarOptions.livenessOwnerToken,
    sessionConfig,
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
    daemonRequested,
    daemonCommand,
    daemonArgs,
    skipCtrlProxyDownload,
    embeddedSdk,
    networkMockable,
    dismissKeyboardAfterInput,
    eventAllMarkers,
    eventAllMarkersCliOverride,
    toolCallRecording,
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
    isRetiredToolsetVariable(name),
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
  const environmentEnabledTools = parseEnvironmentTools(readEnvRaw(ENV.ENABLED_TOOLS, environment));
  const environmentDisabledTools = parseEnvironmentTools(
    readEnvRaw(ENV.DISABLED_TOOLS, environment),
  );
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

  applyQualityPreset(readEnvRaw(ENV.VIDEO_QUALITY_PRESET), "env");
  const envNumbers: Array<[string | undefined, string, boolean, CliVideoRecordingNumericKey]> = [
    [readEnvRaw(ENV.VIDEO_TARGET_BITRATE_KBPS), "video target bitrate", false, "targetBitrateKbps"],
    [readEnvRaw(ENV.VIDEO_MAX_THROUGHPUT_MBPS), "video max throughput", true, "maxThroughputMbps"],
    [readEnvRaw(ENV.VIDEO_FPS), "video fps", false, "fps"],
    [readEnvRaw(ENV.VIDEO_MAX_ARCHIVE_MB), "video max archive size", true, "maxArchiveSizeMb"],
  ];
  for (const [value, label, allowFloat, key] of envNumbers) {
    const parsed = parsePositiveNumber(value, label, allowFloat, log);
    if (parsed !== undefined) {
      videoRecordingDefaults[key] = parsed;
    }
  }
  applyFormat(readEnvRaw(ENV.VIDEO_FORMAT), "env");

  return { videoRecordingDefaults, applyQualityPreset, applyFormat };
}

interface ScalarOptions {
  invalidInvocation?: string;
  daemonPort?: number;
  daemonHost?: string;
  initialSessionUuid?: string;
  livenessOwnerToken?: string;
  sessionConfigValue?: string;
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
  const daemonIndex = args.indexOf("--daemon");
  for (let i = 0; i < args.length; i++) {
    if (["--cli", "--boot-device", "--"].includes(args[i])) {
      break;
    }
    // `--flag=value` is the same option as `--flag value` (#11612): the option parsers below run
    // on a one-pair view, so both forms reach exactly the same code.
    const { flag, inlineValue } = splitFlagToken(args[i]);
    const inline = inlineValue !== undefined && INLINE_LAUNCH_OPTIONS.has(flag);
    const view = inline ? [flag, inlineValue] : args;
    const at = inline ? 0 : i;
    if (flag === "--a11y-use-baseline" && inlineValue !== undefined) {
      const enabled = parseBooleanFlagValue(inlineValue);
      if (enabled === undefined) {
        log.warn(`Invalid value for ${flag}: ${inlineValue}; expected true or false`);
      } else {
        options.a11yUseBaseline = enabled;
      }
      continue;
    }
    const consumed = parseScalarOption(view, at, log, options, video);
    if (consumed !== undefined) {
      // Invalid scalar values still belong to their option; keep the existing
      // warning/default behavior rather than diagnosing them as stray commands.
      i = inline ? i : consumed;
      continue;
    }
    i = inspectInvocationToken(args, i, daemonIndex, options);
  }
  return options;
}

/** Value-taking launcher options that also take `--flag=value`. */
const INLINE_LAUNCH_OPTIONS: ReadonlySet<string> = new Set([
  "--port",
  "--host",
  "--initial-session-uuid",
  "--liveness-owner-token",
  "--a11y-level",
  "--a11y-failure-mode",
  "--a11y-min-severity",
  "--plan-execution-lock-scope",
  RUNNER_READINESS_TIMEOUT_FLAG,
  "--video-quality",
  "--video-quality-preset",
  "--video-target-bitrate-kbps",
  "--video-max-throughput-mbps",
  "--video-fps",
  "--video-format",
  "--video-archive-size-mb",
]);

/** The index of the last token the scalar option at `i` consumed, or undefined if none matched. */
function parseScalarOption(
  args: string[],
  i: number,
  log: ParseLogger,
  options: ScalarOptions,
  video: ReturnType<typeof createVideoRecordingDefaults>,
): number | undefined {
  const connection = parseConnectionOption(args, i, log, options);
  if (connection !== undefined) {
    return Math.max(connection, optionValueEnd(args, i));
  }
  return (
    parseAccessibilityOption(args, i, log, options) ??
    parseReadinessOption(args, i, log, options) ??
    parseVideoOption(args, i, log, video)
  );
}

function optionValueEnd(args: string[], i: number): number {
  return args[i + 1] !== undefined && !args[i + 1].startsWith("--") ? i + 1 : i;
}

function inspectInvocationToken(
  args: string[],
  i: number,
  daemonIndex: number,
  options: ScalarOptions,
): number {
  // These values are resolved by Node's parser or the shared flag helpers.
  // Output-reduction flags are boolean and do not consume a following word.
  if (externalValueFlags.includes(args[i])) {
    return optionValueEnd(args, i);
  }
  // Command tails belong to their command parser. The scalar walk still
  // resolves daemon startup options, but must not reject command arguments.
  if (daemonIndex >= 0 && i >= daemonIndex) {
    return i;
  }
  const malformed = malformedModeInvocation(args[i]);
  if (malformed) {
    options.invalidInvocation ??= malformed;
  } else if (args[i] !== "" && !args[i].startsWith("-")) {
    options.invalidInvocation ??= `Unexpected argument: ${args[i]}; did you mean --cli ${args[i]}?`;
  }
  return unknownLaunchOptionTakesValue(args[i]) ? optionValueEnd(args, i) : i;
}

/** Mode syntax belongs to this scalar walk only before a command's argv boundary. */
function malformedModeInvocation(arg: string): string | undefined {
  if (arg.startsWith("--cli=")) {
    return "Invalid CLI invocation. Use --cli <tool> instead of --cli=<tool>.";
  }
  if (arg.startsWith("--daemon=") || arg.startsWith("--boot-device=")) {
    const [flag, ...value] = arg.split("=");
    const form =
      flag === "--boot-device"
        ? "--boot-device --platform <android|ios>"
        : `${flag} ${value.join("=")}`;
    return `Invalid invocation. Use ${form} instead of ${arg}.`;
  }
  return undefined;
}

/** Preserve forward-compatible launcher values; known booleans consume no word. */
function unknownLaunchOptionTakesValue(arg: string): boolean {
  return (
    arg.startsWith("-") &&
    !arg.includes("=") &&
    !Object.hasOwn(cliOptions, arg.replace(/^-+/, "")) &&
    !OUTPUT_REDUCTION_FLAG_SPECS.some((spec) => spec.cli === arg || spec.disableCli === arg)
  );
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
  const session = parseSessionConfigOption(args, i, options);
  if (session !== undefined) {
    return session;
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

/** `--session-config <json|path>` or `--session-config=<json|path>`. */
function parseSessionConfigOption(
  args: string[],
  i: number,
  options: ScalarOptions,
): number | undefined {
  const arg = args[i];
  if (arg === SESSION_CONFIG_FLAG) {
    const value = args[i + 1]?.trim();
    if (!value || (value.startsWith("--") && !value.startsWith("{"))) {
      throw new SessionConfigError(`${SESSION_CONFIG_FLAG} requires inline JSON or a file path`);
    }
    options.sessionConfigValue = value;
    return i + 1;
  }
  if (arg.startsWith(`${SESSION_CONFIG_FLAG}=`)) {
    options.sessionConfigValue = arg.slice(SESSION_CONFIG_FLAG.length + 1);
    return i;
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

function parseReadinessEnvironment(environment: NodeJS.ProcessEnv, log: ParseLogger) {
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
  return runnerReadinessTimeoutMs;
}

function parseDaemonCommand(args: string[]) {
  const daemonCommandIndex = args.indexOf("--daemon");
  const daemonRequested = daemonCommandIndex >= 0;
  const daemonCommand =
    daemonCommandIndex >= 0 ? args[daemonCommandIndex + 1] || undefined : undefined;
  const daemonArgs = daemonCommandIndex >= 0 ? args.slice(daemonCommandIndex + 2) : [];
  return { daemonRequested, daemonCommand, daemonArgs };
}
