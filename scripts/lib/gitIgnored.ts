import { spawnSync } from "node:child_process";

/** Result of `git check-ignore -z --stdin`: exit status and NUL-separated stdout. */
export interface CheckIgnoreResult {
  status: number | null;
  stdout: string;
}

export type CheckIgnore = (root: string, input: string) => CheckIgnoreResult;

const runCheckIgnore: CheckIgnore = (root, input) => {
  const result = spawnSync("git", ["-C", root, "check-ignore", "-z", "--stdin"], {
    input,
    encoding: "utf8",
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "" };
};

/**
 * Drops the paths git ignores (relative to `root`), so a docs scan sees what CI sees: locally
 * generated, gitignored files such as docs/changelog.md never exist on a CI checkout. When git
 * cannot decide (not a work tree, git missing) nothing is dropped.
 */
export function dropGitIgnored(
  root: string,
  paths: string[],
  checkIgnore: CheckIgnore = runCheckIgnore,
): string[] {
  if (paths.length === 0) {
    return paths;
  }
  const result = checkIgnore(root, paths.join("\0"));
  // Exit 0: some paths ignored. Exit 1: none ignored. Anything else: git could not decide.
  if (result.status !== 0) {
    return paths;
  }
  const ignored = new Set(result.stdout.split("\0").filter(Boolean));
  return paths.filter((path) => !ignored.has(path));
}
