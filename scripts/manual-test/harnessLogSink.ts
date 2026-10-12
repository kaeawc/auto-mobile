/** Import before product modules: their logger creates file state at module evaluation. */
import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface HarnessLogSinkOverride {
  name: string;
  previous: string | undefined;
}
interface LogSinkFs {
  realpath(path: string): string;
}
function inside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
/** Missing leaves inherit the real path of their deepest existing ancestor. */
function ancestorRealpath(path: string, fs: LogSinkFs): string {
  try {
    return fs.realpath(path);
  } catch (error) {
    // Only missing ancestors are recoverable; permission errors and symlink loops fail closed.
    const missing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR");
    if (!missing || dirname(path) === path) {
      throw error;
    }
    return join(ancestorRealpath(dirname(path), fs), basename(path));
  }
}
function safeLogDirectory(
  value: string | undefined,
  homes: readonly string[],
  fs: LogSinkFs,
): boolean {
  if (!value || !isAbsolute(value) || value.includes("\0") || homes.length === 0) {
    return false;
  }
  const candidate = resolve(value);
  const roots = homes.map((home) => resolve(home, ".auto-mobile"));
  if (roots.some((root) => inside(candidate, root))) {
    return false;
  }
  try {
    const canonical = ancestorRealpath(candidate, fs);
    return roots.every(
      (root) => !inside(canonical, root) && !inside(canonical, ancestorRealpath(root, fs)),
    );
  } catch (error) {
    // Unresolvable paths cannot prove import-time file logging is isolated.
    return false;
  }
}
export function selectHarnessLogSink(
  env: Record<string, string | undefined>,
  homeDirs?: readonly string[],
  fs: LogSinkFs = { realpath: realpathSync },
): HarnessLogSinkOverride[] {
  const sink = (env.AUTOMOBILE_LOG_SINK ?? env.AUTO_MOBILE_LOG_SINK)?.trim().toLowerCase();
  if (sink === "stderr") {
    return [];
  }
  // Match product ?? precedence, including an empty canonical value shadowing the legacy one.
  // Data-dir-only logging is deliberately forced to stderr: require an explicit safe log dir.
  const directory = (env.AUTOMOBILE_LOG_DIR ?? env.AUTO_MOBILE_LOG_DIR)?.trim();
  if (directory && safeLogDirectory(directory, homeDirs ?? [homedir(), userInfo().homedir], fs)) {
    return [];
  }
  // The canonical value wins over every legacy fallback; no legacy mutation is necessary.
  const selected = [{ name: "AUTOMOBILE_LOG_SINK", previous: env.AUTOMOBILE_LOG_SINK }];
  env.AUTOMOBILE_LOG_SINK = "stderr";
  return selected;
}
const overrides = selectHarnessLogSink(process.env);
export function harnessLogSinkOverride(): HarnessLogSinkOverride[] {
  return overrides;
}
/** Undo every import-time selection, including variables that were originally unset. */
export function harnessChildEnvironment(
  env: Record<string, string | undefined>,
  selected: readonly HarnessLogSinkOverride[] = harnessLogSinkOverride(),
): Record<string, string | undefined> {
  const child = { ...env };
  for (const override of selected) {
    if (override.previous === undefined) {
      delete child[override.name];
    } else {
      child[override.name] = override.previous;
    }
  }
  return child;
}
