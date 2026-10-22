import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface GitListingResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface WorkingTreeFilesDeps {
  runGit(args: string[], cwd: string): GitListingResult;
  exists(file: string): boolean;
}

const realDeps: WorkingTreeFilesDeps = {
  runGit: (args, cwd) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error,
    };
  },
  exists: existsSync,
};

/**
 * Repository-relative files of the working tree a guard validates: tracked plus untracked,
 * non-ignored files (jj checkouts never stage, and a git lane may not have run `git add` yet),
 * minus index entries absent on disk (an unstaged delete, a sparse or partial checkout). This
 * matches what the next commit will hold in both VCS modes, so a guard neither reads a file that
 * is not there nor rejects a reference to a file that is (#14717). Ignored generated output and
 * `scratch/` stay out. Works from a git worktree, whose `.git` is a file.
 */
export function workingTreeFiles(
  root: string,
  pathspecs: readonly string[] = [],
  deps: WorkingTreeFilesDeps = realDeps,
): string[] {
  const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  const result = deps.runGit(pathspecs.length > 0 ? [...args, "--", ...pathspecs] : args, root);
  if (result.error || result.status !== 0) {
    const cause = result.error?.message ?? `exit ${result.status}: ${result.stderr.trim()}`;
    throw new Error(
      `git ls-files failed in ${root} (${cause}). This guard enumerates the working tree through ` +
        "git, so run it from a git checkout or `git worktree` of the repository; a copied tree or " +
        "a jj workspace without a colocated .git cannot be scanned.",
    );
  }
  return [...new Set(result.stdout.split("\0"))].filter(
    (file) => file !== "" && deps.exists(path.join(root, file)),
  );
}
