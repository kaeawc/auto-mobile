/**
 * Typed registry of environment variables (#11848).
 *
 * Every variable AutoMobile reads should be declared here once, with its legacy
 * spelling, kind, default and a one-line description, and read through
 * {@link readEnvTrimmed}. Readers take an injected `env` so tests never mutate
 * `process.env`. Unmigrated raw reads are listed in
 * `test/lint/env-registry-baseline.txt`, which may only shrink.
 */

export type EnvVarKind = "path" | "string";

export interface EnvVarSpec {
  /** Canonical variable name. */
  readonly name: string;
  /** Deprecated `AUTO_MOBILE_` spelling, consulted only when `name` is unset. */
  readonly legacyName?: string;
  readonly kind: EnvVarKind;
  /** Human-readable default (documentation only; resolution stays at the call site). */
  readonly default: string;
  readonly doc: string;
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
