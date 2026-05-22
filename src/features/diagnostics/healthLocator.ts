import path from "path";

export interface HealthLocatorOptions {
  envValue: string | undefined;
  homeDir: string;
}

/**
 * Resolve the directory where end-of-run health summaries should land.
 *
 * Resolution order (first match wins):
 *
 *  1. `AUTOMOBILE_HEALTH_DIR` — explicit operator override. CI sets this to its
 *     artifact directory so the JSON files are uploaded with the rest of the run.
 *  2. `<homeDir>/.auto-mobile/health/` — default for local devs and ad-hoc
 *     `bunx … --daemon start` users.
 *
 * The returned path is normalized but not created here; callers are responsible
 * for `mkdir -p` on the directory before writing.
 */
export function resolveHealthDir(options: HealthLocatorOptions): string {
  const { envValue, homeDir } = options;

  const trimmedEnv = envValue?.trim();
  if (trimmedEnv && trimmedEnv.length > 0) {
    return path.resolve(trimmedEnv);
  }

  return path.join(homeDir, ".auto-mobile", "health");
}

/**
 * Construct the filename for a run's health summary. Format chosen to:
 *  - sort lexicographically by start time (`ls -t` or alpha-sort gives newest first),
 *  - be safe on every common filesystem (no colons or path separators),
 *  - encode session UUID when present so users can grep across files for a
 *    known JUnit session,
 *  - fall back to a short random suffix for ad-hoc runs so unrelated runs in
 *    the same millisecond don't collide.
 */
export function buildHealthFilename(
  sessionId: string | null,
  startedAt: Date,
  randomSuffix: string
): string {
  const iso = startedAt.toISOString().replace(/[:.]/g, "-");
  if (sessionId) {
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `health-${iso}-${safeSession}.json`;
  }
  return `health-${iso}-adhoc-${randomSuffix}.json`;
}
