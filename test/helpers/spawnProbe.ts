/** The slice of a `Bun.spawnSync` result that a JSON-printing probe child needs. */
export interface ProbeSpawnResult {
  exitCode: number | null;
  signalCode?: string | number | null;
  exitedDueToTimeout?: boolean;
  stdout: { toString(): string };
  stderr: { toString(): string };
}

/**
 * Parse the JSON a probe child printed. An empty or unparsable stdout used to surface as a bare
 * `SyntaxError: JSON Parse error: Unexpected EOF`, hiding whether the child timed out, was
 * killed, or exited non-zero (the Windows `dataDir.test.ts` CI failure). Fail with all of it.
 */
export function parseProbeJson<T>(result: ProbeSpawnResult): T {
  const stdout = result.stdout.toString();
  try {
    return JSON.parse(stdout) as T;
  } catch (cause) {
    const stderr = result.stderr.toString();
    throw new Error(
      `probe child printed no parsable JSON (exitCode=${result.exitCode}, ` +
        `signal=${result.signalCode ?? "none"}, timedOut=${result.exitedDueToTimeout ?? false}); ` +
        `stdout=${JSON.stringify(stdout.slice(0, 500))} stderr=${JSON.stringify(stderr.slice(0, 2000))}`,
      { cause },
    );
  }
}
