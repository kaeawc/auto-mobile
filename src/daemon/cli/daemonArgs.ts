import {
  END_OF_OPTIONS,
  parseBooleanFlagValue,
  readValueOperand,
  splitFlagToken,
} from "../../utils/flagTokens";
import { parsePort, parsePositiveNumber, type ParseLogger } from "../../cli/numericValidators";
import { logger } from "../../utils/logger";
import {
  LEGACY_SKIP_ACCESSIBILITY_DOWNLOAD_FLAG,
  SKIP_CTRL_PROXY_DOWNLOAD_FLAG,
  shouldSkipCtrlProxyDownload,
} from "../../utils/ctrlProxyDownloadControl";
import {
  EVENT_ALL_MARKERS_FLAG,
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
import {
  OUTPUT_REDUCTION_FLAG_SPECS,
  parseOutputReductionFlags,
} from "../../utils/outputReductionFlags";
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
  "--tool-call-recording": "toolCallRecording",
  "--observe-result-include-elements": "observeResultIncludeElements",
  "--tool-results-no-structured-content": "toolResultsNoStructuredContent",
  "--actions-diff-observe": "actionsDiffObserve",
  "--actions-no-observe": "actionsNoObserve",
};

function hasDaemonFlagValue(value: string | undefined): value is string {
  return value !== undefined && !value.startsWith("--");
}

function setDaemonHost(options: DaemonOptions, value: string | undefined): boolean {
  if (!value) {
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
  if (!value) {
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
  if (!value) {
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

interface DaemonFlagOperand {
  value: string | undefined;
  inline: boolean;
}

/** Whether the operand is a value for its flag (an inline one always is). */
function operandHasValue({ value, inline }: DaemonFlagOperand): boolean {
  return value !== undefined && (inline || hasDaemonFlagValue(value));
}

/** The numeric, string and port flags; undefined when `flag` is none of them. */
function consumeDaemonScalarFlag(
  flag: string,
  operand: DaemonFlagOperand,
  options: DaemonOptions,
  log: ParseLogger,
): boolean | undefined {
  const { value } = operand;
  const hasValue = operandHasValue(operand);
  const numericFlag = Object.hasOwn(numericFlags, flag) ? numericFlags[flag] : undefined;
  if (numericFlag) {
    options[numericFlag.field] = parsePositiveNumber(
      value,
      numericFlag.label,
      numericFlag.allowFloat,
      log,
    );
    return hasValue;
  }
  const stringField = Object.hasOwn(stringFlags, flag) ? stringFlags[flag] : undefined;
  if (stringField) {
    if (hasValue) {
      options[stringField] = value;
    }
    return hasValue;
  }
  if (flag === "--port") {
    options.port = parsePort(value, log);
    return hasValue;
  }
  return undefined;
}

/** The table-driven value flags; undefined when `flag` is not one of them. */
function consumeDaemonValueFlag(
  flag: string,
  operand: DaemonFlagOperand,
  options: DaemonOptions,
  log: ParseLogger,
): boolean | undefined {
  const scalar = consumeDaemonScalarFlag(flag, operand, options, log);
  if (scalar !== undefined) {
    return scalar;
  }
  const valueFlag = Object.hasOwn(valueFlags, flag) ? valueFlags[flag] : undefined;
  if (!valueFlag) {
    return undefined;
  }
  const { value } = operand;
  const hasValue = operandHasValue(operand);
  const applied = valueFlag(options, hasValue ? value : undefined);
  if (!applied && hasValue) {
    log.warn(`Ignoring invalid value for ${flag}: ${value}`);
  }
  return applied;
}

/**
 * Apply one flag to `options`. An `inline` (`--flag=value`) operand is always a value, a
 * separate one is only a value when it is not itself a flag. Returns whether a separate
 * following token was consumed as the value.
 */
function consumeDaemonFlag(
  flag: string,
  operand: DaemonFlagOperand,
  options: DaemonOptions,
  log: ParseLogger,
): boolean {
  const consumed = consumeDaemonValueFlag(flag, operand, options, log);
  if (consumed !== undefined) {
    return consumed;
  }
  const booleanField = Object.hasOwn(booleanFlags, flag) ? booleanFlags[flag] : undefined;
  if (booleanField) {
    const enabled = parseBooleanFlagValue(operand.inline ? operand.value : undefined);
    if (enabled === undefined) {
      log.warn(`Invalid value for ${flag}: ${operand.value}; expected true or false`);
    } else {
      options[booleanField] = enabled;
    }
  }
  return false;
}

/** Apply every flag token before a bare `--`, in either `--flag value` or `--flag=value` form. */
function applyDaemonFlagTokens(args: string[], options: DaemonOptions, log: ParseLogger): void {
  for (let i = 0; i < args.length && args[i] !== END_OF_OPTIONS; i++) {
    const operand = readValueOperand(args, i);
    if (consumeDaemonFlag(operand.flag, operand, options, log)) {
      i = operand.last;
    }
  }
}

export function parseDaemonArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  log: ParseLogger = logger,
): DaemonOptions {
  const options: DaemonOptions = shouldSkipCtrlProxyDownload(args, env)
    ? { skipCtrlProxyDownload: true }
    : {};
  const compactMetadata = parseOutputReductionFlags(args, env).actionsCompactMetadata;
  if (compactMetadata !== undefined) {
    options.actionsCompactMetadata = compactMetadata;
  }
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
  applyDaemonFlagTokens(args, options, log);
  return options;
}

/**
 * Value-taking flags a daemon command tail may carry besides parseDaemonArgs' own: the shared
 * launcher flags `parseArgs` resolves from the same argv. `--daemon-socket-path` is a discovery
 * marker only.
 */
const SHARED_LAUNCH_VALUE_FLAGS = [EVENT_ALL_MARKERS_FLAG, "--daemon-socket-path"];

/** Boolean shared launcher flags a daemon command tail may carry besides parseDaemonArgs' own. */
const SHARED_LAUNCH_BOOLEAN_FLAGS = [
  SKIP_CTRL_PROXY_DOWNLOAD_FLAG,
  LEGACY_SKIP_ACCESSIBILITY_DOWNLOAD_FLAG,
  ...OUTPUT_REDUCTION_FLAG_SPECS.flatMap((spec) =>
    spec.disableCli ? [spec.cli, spec.disableCli] : [spec.cli],
  ),
];

export const DAEMON_LAUNCH_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--port",
  ...Object.keys(numericFlags),
  ...Object.keys(stringFlags),
  ...Object.keys(valueFlags),
  ...SHARED_LAUNCH_VALUE_FLAGS,
]);

export const DAEMON_LAUNCH_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  ...Object.keys(booleanFlags),
  ...SHARED_LAUNCH_BOOLEAN_FLAGS,
]);

/** Extra flags one daemon command accepts on top of (or instead of) the launch flags. */
export interface DaemonCommandFlagSpec {
  /** Whether the shared daemon launch flags (`--port`, `--debug`, ...) are accepted. */
  launchFlags: boolean;
  valueFlags?: readonly string[];
  booleanFlags?: readonly string[];
  /** How many positional words the command takes (default 0). */
  positionals?: number;
}

/** Why a daemon command's argument tail is invalid: a stray word, an unknown option or a bad value. */
export type InvalidDaemonArgument =
  | { kind: "positional"; argument: string }
  | { kind: "option"; argument: string }
  | { kind: "value"; argument: string };

function invalidBooleanOrUnknownOption(
  arg: string,
  isBooleanFlag: (flag: string) => boolean,
): InvalidDaemonArgument | undefined {
  const { flag, inlineValue } = splitFlagToken(arg);
  if (!isBooleanFlag(flag)) {
    return { kind: "option", argument: arg };
  }
  return parseBooleanFlagValue(inlineValue) === undefined
    ? { kind: "value", argument: arg }
    : undefined;
}

/**
 * The first argument a daemon command cannot accept (#11252): a stray word (`--daemon stop
 * <sessionId>` would otherwise stop the whole daemon), an unknown option (`restart --stict-port`
 * would otherwise drop the flag silently), or a boolean flag given a value other than
 * true/false. A word right after a value-taking flag is that flag's value; `--flag=value` is that
 * same flag (both forms go through the tokenizer in `utils/flagTokens`, which the readers use too).
 * A bare `--` ends the options. At most `spec.positionals` (default 0) words are accepted.
 */
export function invalidDaemonCommandArgument(
  args: string[],
  spec: DaemonCommandFlagSpec,
): InvalidDaemonArgument | undefined {
  const isValueFlag = (flag: string) =>
    (spec.launchFlags && DAEMON_LAUNCH_VALUE_FLAGS.has(flag)) ||
    (spec.valueFlags?.includes(flag) ?? false);
  const isBooleanFlag = (flag: string) =>
    (spec.launchFlags && DAEMON_LAUNCH_BOOLEAN_FLAGS.has(flag)) ||
    (spec.booleanFlags?.includes(flag) ?? false);
  const maxPositionals = spec.positionals ?? 0;
  let positionals = 0;
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "") {
      continue;
    }
    if (arg === END_OF_OPTIONS && !optionsEnded) {
      optionsEnded = true;
    } else if (optionsEnded || !arg.startsWith("-")) {
      positionals++;
      if (positionals > maxPositionals) {
        return { kind: "positional", argument: arg };
      }
    } else if (isValueFlag(splitFlagToken(arg).flag)) {
      i = readValueOperand(args, i).last;
    } else {
      const invalid = invalidBooleanOrUnknownOption(arg, isBooleanFlag);
      if (invalid) {
        return invalid;
      }
    }
  }
  return undefined;
}
