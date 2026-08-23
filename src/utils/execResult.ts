import type { ExecResult } from "../models";

/**
 * Canonical `ExecResult` factory. Accepts raw `Buffer` stdout/stderr (as node's
 * `execFile` yields when `encoding` is unset) and coerces to strings, so the
 * Buffer→string coercion lives here in exactly one place rather than being
 * re-inlined at every exec seam.
 */
export function createExecResult(stdout: string | Buffer, stderr: string | Buffer): ExecResult {
  return {
    stdout: typeof stdout === "string" ? stdout : stdout.toString(),
    stderr: typeof stderr === "string" ? stderr : stderr.toString(),
    toString() {
      return this.stdout;
    },
    trim() {
      return this.stdout.trim();
    },
    includes(searchString: string) {
      return this.stdout.includes(searchString);
    },
  };
}
