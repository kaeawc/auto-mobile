import { spawnSync } from "node:child_process";

/**
 * Runs oxfmt over `input` as if it were the file at `filepath`, returning the
 * exit status and streams. Injected so tests never spawn the real formatter.
 */
export type OxfmtRunner = (
  input: string,
  filepath: string,
  cwd: string,
) => { status: number | null; stdout: string; stderr: string };

export const bunxOxfmt: OxfmtRunner = (input, filepath, cwd) => {
  const result = spawnSync("bunx", ["oxfmt", "--stdin-filepath", filepath], {
    cwd,
    input,
    encoding: "utf8",
  });
  if (result.error) {
    return { status: null, stdout: "", stderr: String(result.error.message) };
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** `JSON.stringify(value, null, 2)` plus a trailing newline. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Serializes `value` and formats it with the repository formatter so a
 * generated JSON file is byte-identical to what `oxfmt --check` expects
 * (#18333). `filepath` is repo-relative so `.oxfmtrc.json` applies.
 */
export function formatJsonWithOxfmt(
  value: unknown,
  filepath: string,
  cwd: string,
  run: OxfmtRunner = bunxOxfmt,
): string {
  const result = run(stableJson(value), filepath, cwd);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || `exit ${String(result.status)}`;
    throw new Error(`oxfmt failed to format ${filepath}: ${detail}`);
  }
  if (result.stdout.trim() === "") {
    throw new Error(`oxfmt produced no output for ${filepath}.`);
  }
  return result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`;
}
