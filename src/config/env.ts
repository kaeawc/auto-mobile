/**
 * Typed registry of environment variables (#11848).
 *
 * Every variable AutoMobile reads should be declared here once, with its legacy
 * spelling, kind, default and a one-line description, and read through
 * {@link readEnvTrimmed}. Readers take an injected `env` so tests never mutate
 * `process.env`. Unmigrated raw reads are listed in
 * `test/lint/env-registry-baseline.txt`, which may only shrink.
 */

export type EnvVarKind = "path" | "string" | "bool" | "int" | "number" | "enum" | "list";

export interface EnvVarSpec {
  /** Canonical variable name. */
  readonly name: string;
  /** Deprecated `AUTO_MOBILE_` spelling, consulted only when `name` is unset. */
  readonly legacyName?: string;
  readonly kind: EnvVarKind;
  /** Human-readable default (documentation only; resolution stays at the call site). */
  readonly default: string;
  readonly doc: string;
  /** `int` / `number`: smallest accepted value (inclusive unless `minExclusive`). */
  readonly min?: number;
  readonly minExclusive?: boolean;
  /** `int`: value used when the variable is unset or unusable. */
  readonly fallback?: number;
  /** `enum`: accepted lowercase values. */
  readonly values?: readonly string[];
}

export const ENV = {
  DATA_DIR: {
    name: "AUTOMOBILE_DATA_DIR",
    legacyName: "AUTO_MOBILE_DATA_DIR",
    kind: "path",
    default: "~/.auto-mobile",
    doc: "Base directory for AutoMobile state; relative to the daemon launch directory.",
  },
  LOG_DIR: {
    name: "AUTOMOBILE_LOG_DIR",
    legacyName: "AUTO_MOBILE_LOG_DIR",
    kind: "path",
    default: "$AUTOMOBILE_DATA_DIR/logs",
    doc: "Daemon and client log directory; relative to the daemon launch directory.",
  },
  COORDINATION_DIR: {
    name: "AUTOMOBILE_COORDINATION_DIR",
    legacyName: "AUTO_MOBILE_COORDINATION_DIR",
    kind: "path",
    default: "~/.auto-mobile",
    doc: "Absolute root of cross-process coordination state shared by cooperating agents.",
  },
  ADB_SERVER_COORDINATION_DIR: {
    name: "AUTOMOBILE_ADB_SERVER_COORDINATION_DIR",
    legacyName: "AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR",
    kind: "path",
    default: "~/.auto-mobile/adb-servers",
    doc: "Absolute root of per-ADB-server claims shared by every daemon on one ADB server.",
  },
  PRIVATE_DAEMON_ORPHAN_IDLE_MS: {
    name: "AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS",
    kind: "number",
    default: "900000",
    min: 0,
    doc: "Idle timeout in ms for an orphaned private daemon; 0 disables the watchdog.",
  },
  OBSERVE_PERF_SNAPSHOT: {
    name: "AUTOMOBILE_OBSERVE_PERF_SNAPSHOT",
    legacyName: "AUTO_MOBILE_OBSERVE_PERF_SNAPSHOT",
    kind: "bool",
    default: "off",
    doc: "Attach a windowed performance snapshot to observe results.",
  },
  OBSERVE_PERF_WINDOW_MS: {
    name: "AUTOMOBILE_OBSERVE_PERF_WINDOW_MS",
    legacyName: "AUTO_MOBILE_OBSERVE_PERF_WINDOW_MS",
    kind: "number",
    default: "5000",
    min: 0,
    minExclusive: true,
    doc: "Rolling window for the performance snapshot; fractions are rounded.",
  },
  VIDEO_RETENTION_DAYS: {
    name: "AUTOMOBILE_VIDEO_RETENTION_DAYS",
    legacyName: "AUTO_MOBILE_VIDEO_RETENTION_DAYS",
    kind: "number",
    default: "see docs",
    min: 0,
    doc: "Age in days after which recordings are deleted; 0 disables the sweep.",
  },
  VIDEO_RETENTION_SWEEP_MINUTES: {
    name: "AUTOMOBILE_VIDEO_RETENTION_SWEEP_MINUTES",
    legacyName: "AUTO_MOBILE_VIDEO_RETENTION_SWEEP_MINUTES",
    kind: "number",
    default: "see docs",
    min: 0,
    minExclusive: true,
    doc: "How often the recording retention sweep runs, in minutes.",
  },
  VIDEO_INPROGRESS_CHECK_SECONDS: {
    name: "AUTOMOBILE_VIDEO_INPROGRESS_CHECK_SECONDS",
    legacyName: "AUTO_MOBILE_VIDEO_INPROGRESS_CHECK_SECONDS",
    kind: "number",
    default: "see docs",
    min: 0,
    minExclusive: true,
    doc: "How often an in-progress recording's size is checked, in seconds.",
  },
  PORT_RANGE_START: {
    name: "AUTOMOBILE_PORT_RANGE_START",
    legacyName: "AUTO_MOBILE_PORT_RANGE_START",
    kind: "int",
    default: "see docs",
    min: 1,
    doc: "First CtrlProxy host port.",
  },
  PORT_RANGE_END: {
    name: "AUTOMOBILE_PORT_RANGE_END",
    legacyName: "AUTO_MOBILE_PORT_RANGE_END",
    kind: "string",
    default: "unset",
    doc: "Inclusive last CtrlProxy host port.",
  },
  PORT_RANGE_SIZE: {
    name: "AUTOMOBILE_PORT_RANGE_SIZE",
    legacyName: "AUTO_MOBILE_PORT_RANGE_SIZE",
    kind: "string",
    default: "unset",
    doc: "Number of CtrlProxy host ports.",
  },
  DOCTOR_TIMEOUT_MS: {
    name: "AUTOMOBILE_DOCTOR_TIMEOUT_MS",
    kind: "int",
    default: "5000",
    fallback: 5000,
    min: 1,
    doc: "Timeout in ms for each external doctor probe.",
  },
  WORK_PROFILE_POLL_INTERVAL_MS: {
    name: "AUTOMOBILE_WORK_PROFILE_POLL_INTERVAL_MS",
    kind: "int",
    default: "5000",
    min: 1,
    doc: "Work-profile polling interval in ms.",
  },
  DISABLE_PERF_AUDIT: {
    name: "AUTOMOBILE_DISABLE_PERF_AUDIT",
    kind: "bool",
    default: "off",
    doc: "Disable the UI performance audit.",
  },
  TOUCH_LATENCY_SAMPLING: {
    name: "AUTOMOBILE_TOUCH_LATENCY_SAMPLING",
    kind: "bool",
    default: "off",
    doc: "Opt into synthetic tap latency sampling.",
  },
  MAX_OBSERVATION_AGE_MS: {
    name: "AUTOMOBILE_MAX_OBSERVATION_AGE_MS",
    kind: "int",
    default: "see docs",
    min: 1,
    doc: "Hierarchy freshness budget in ms.",
  },
  IOS_SCREEN_CAPTURE_HELPER: {
    name: "AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER",
    legacyName: "AUTO_MOBILE_IOS_SCREEN_CAPTURE_HELPER",
    kind: "path",
    default: "unset",
    doc: "Absolute path to a locally built screen-capture-helper.",
  },
  ACTION_OBSERVATION_SKIP_SCREENSHOT: {
    name: "AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT",
    kind: "string",
    default: "skip",
    doc: "Skip automatic screenshots after actions unless set to false or 0.",
  },
  OBSERVE_WAIT_FOR_SKIP_SCREENSHOT: {
    name: "AUTOMOBILE_OBSERVE_WAIT_FOR_SKIP_SCREENSHOT",
    kind: "string",
    default: "skip",
    doc: "Skip automatic screenshots for waitFor observations unless set to false or 0.",
  },
  OBSERVE_SETTLED_SCREENSHOT: {
    name: "AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT",
    kind: "string",
    default: "unset",
    doc: "Select settled screenshot mode with true or 1.",
  },
} as const satisfies Record<string, EnvVarSpec>;

export const ENV_REGISTRY: readonly EnvVarSpec[] = Object.values(ENV);

/**
 * Raw value of a variable: the canonical name wins whenever it is set (even to
 * an empty string), otherwise the legacy spelling is consulted.
 */
export function readEnvRaw(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[spec.name] ?? (spec.legacyName === undefined ? undefined : env[spec.legacyName]);
}

/** Trimmed value, or undefined when unset or blank. */
export function readEnvTrimmed(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = readEnvRaw(spec, env)?.trim();
  return value ? value : undefined;
}

/** Lowercase `1` / `true` / `yes` (trimmed) are true; anything else, including unset, is false. */
export function readEnvBool(spec: EnvVarSpec, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = readEnvRaw(spec, env)?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Lenient finite number (fractions allowed), bounded by `spec.min`. Undefined when the
 * variable is unset/blank (not reported) or unusable (`onInvalid` receives the raw text).
 */
export function readEnvNumber(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv = process.env,
  onInvalid?: (raw: string) => void,
): number | undefined {
  const raw = readEnvTrimmed(spec, env);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  const min = spec.min ?? Number.NEGATIVE_INFINITY;
  if (Number.isFinite(parsed) && (spec.minExclusive ? parsed > min : parsed >= min)) {
    return parsed;
  }
  onInvalid?.(raw);
  return undefined;
}

/** Trimmed, lowercased value when it is one of `spec.values`, else undefined. */
export function readEnvEnum(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = readEnvTrimmed(spec, env)?.toLowerCase();
  return value !== undefined && spec.values?.includes(value) ? value : undefined;
}

/** Comma-separated list with entries trimmed and blanks dropped. */
export function readEnvList(spec: EnvVarSpec, env: NodeJS.ProcessEnv = process.env): string[] {
  return (readEnvTrimmed(spec, env) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
