import { readEnvPositiveInteger } from "./envNumbers";

/**
 * Bound every external diagnostic call. Tools like `xcrun`, the keychain
 * CLI, and `xcode-select` can block indefinitely (license prompts, stuck
 * keychain, missing CLT). Without a timeout a single wedged tool hangs the whole
 * `doctor` run. On timeout execFile rejects, which each check already turns into
 * a clean `fail` result. Overridable for slow CI hosts via
 * AUTOMOBILE_DOCTOR_TIMEOUT_MS.
 */
export function resolveDoctorExecTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return readEnvPositiveInteger("AUTOMOBILE_DOCTOR_TIMEOUT_MS", undefined, { fallback: 5000 }, env);
}

/** Resolved once at module load (the probes share one budget); tests use {@link resolveDoctorExecTimeoutMs}. */
export const DOCTOR_EXEC_TIMEOUT_MS = resolveDoctorExecTimeoutMs();
