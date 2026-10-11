import { logger } from "./logger";

/** The slice of the logger the env readers need. */
export interface EnvNumberLogger {
  warn(message: string): void;
}

export interface EnvPositiveIntegerSpec {
  /** Env var names in priority order; the first one that is set decides. */
  names: readonly string[];
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
  spec: EnvPositiveIntegerSpec,
  env: NodeJS.ProcessEnv = process.env,
  log: EnvNumberLogger = logger,
): number {
  return readOptionalEnvPositiveInteger(spec, env, log) ?? spec.fallback;
}

/** Like {@link readEnvPositiveInteger}, but the caller owns the default: undefined when unusable. */
export function readOptionalEnvPositiveInteger(
  spec: Omit<EnvPositiveIntegerSpec, "fallback"> & { fallback?: number },
  env: NodeJS.ProcessEnv = process.env,
  log: EnvNumberLogger = logger,
): number | undefined {
  const name = spec.names.find((candidate) => env[candidate] !== undefined);
  const raw = name === undefined ? "" : (env[name] ?? "").trim();
  if (name === undefined || raw === "") {
    return undefined;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed !== undefined && parsed >= (spec.min ?? 1)) {
    return parsed;
  }
  warnOnce(log, name, raw, spec);
  return undefined;
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
  spec: Omit<EnvPositiveIntegerSpec, "fallback"> & { fallback?: number },
): void {
  const key = `${name}=${raw}`;
  if (warned.has(key)) {
    return;
  }
  warned.add(key);
  const floor = spec.min !== undefined ? ` of at least ${spec.min}` : "";
  log.warn(
    `Ignoring ${name}=${JSON.stringify(raw)}: expected a plain integer${floor}; ` +
      `using the default${spec.fallback === undefined ? "" : ` ${spec.fallback}`}`,
  );
}
