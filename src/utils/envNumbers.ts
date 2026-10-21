import type { EnvVarSpec } from "../config/env";
import { logger } from "./logger";

/** The slice of the logger the env readers need. */
export interface EnvNumberLogger {
  warn(message: string): void;
}

export interface EnvPositiveIntegerOptions {
  /** The value used when the variable is unset, empty, malformed or below `min`. */
  fallback: number;
  /** Smallest accepted value; a smaller one is a typo or a hazard, not a preference. */
  min?: number;
}

const warned = new Set<string>();

/**
 * Read a positive base-10 integer from the environment, strictly (#11612). `Number.parseInt`
 * accepts a numeric prefix, so a unit suffix turns minutes into milliseconds (`"2m"` is 2 ms,
 * `"1e5"` is 1); this accepts digits only. A value that is set but unusable (malformed, zero,
 * unsafe, or below `min`) falls back to `fallback` with a `warn` naming the variable and the
 * value, once per distinct pair. An unset or empty variable is the default without a warning.
 */
export function readEnvPositiveInteger(
  primaryName: string,
  legacyName: string | undefined,
  options: EnvPositiveIntegerOptions,
  env: NodeJS.ProcessEnv = process.env,
  log: EnvNumberLogger = logger,
): number {
  return (
    readOptionalEnvPositiveInteger(primaryName, legacyName, options, env, log) ?? options.fallback
  );
}

/** Like {@link readEnvPositiveInteger}, but the caller owns the default: undefined when unusable. */
export function readOptionalEnvPositiveInteger(
  primaryName: string,
  legacyName: string | undefined,
  options: Partial<EnvPositiveIntegerOptions> = {},
  env: NodeJS.ProcessEnv = process.env,
  log: EnvNumberLogger = logger,
): number | undefined {
  const { name, raw } = pickEnvEntry(primaryName, legacyName, env);
  if (raw === "") {
    return undefined;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed !== undefined && parsed >= (options.min ?? 1)) {
    return parsed;
  }
  warnOnce(log, name, raw, options);
  return undefined;
}

/** The primary name decides whenever it is set, even to an unusable value. */
function pickEnvEntry(
  primaryName: string,
  legacyName: string | undefined,
  env: NodeJS.ProcessEnv,
): { name: string; raw: string } {
  if (env[primaryName] !== undefined || legacyName === undefined) {
    return { name: primaryName, raw: (env[primaryName] ?? "").trim() };
  }
  return { name: legacyName, raw: (env[legacyName] ?? "").trim() };
}

/** A positive safe integer written as plain base-10 digits, or undefined. */
export function parseStrictPositiveInteger(raw: string): number | undefined {
  const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function warnOnce(
  log: EnvNumberLogger,
  name: string,
  raw: string,
  options: Partial<EnvPositiveIntegerOptions>,
): void {
  const key = `${name}=${raw}`;
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  const floor = options.min !== undefined ? ` of at least ${options.min}` : "";
  log.warn(
    `Ignoring ${name}=${JSON.stringify(raw)}: expected a plain integer${floor}; ` +
      `using the default${options.fallback === undefined ? "" : ` ${options.fallback}`}`,
  );
}

/**
 * Registry-driven {@link readEnvPositiveInteger}: the spec supplies the names and `min`;
 * the default comes from `options.fallback` or `spec.fallback`. Parsing is strict-positive, so
 * `spec.min` should be at least 1; callers should always supply a fallback.
 */
export function readEnvInt(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv = process.env,
  options: { fallback?: number; log?: EnvNumberLogger } = {},
): number {
  return readEnvPositiveInteger(
    spec.name,
    spec.legacyName,
    { fallback: options.fallback ?? spec.fallback ?? 0, min: spec.min },
    env,
    options.log ?? logger,
  );
}
