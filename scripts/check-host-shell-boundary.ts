import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { BOUNDARY_ROWS } from "./lib/boundaryRows";
import { type BoundaryViolation, renderBoundaryResult, scanBoundary } from "./lib/boundaryScanner";

// Resolves the changed src/ files against a base ref (Git or jj) and runs the `host-shell` row of
// the table-driven boundary scanner over them (issue #13219). The detector lives in
// scripts/lib/hostShellBoundary.ts.

const SOURCE_ROOT = "src";

type CommandRunner = (file: string, args: string[]) => string;

const runCommand: CommandRunner = (file, args) => execFileSync(file, args, { encoding: "utf8" });

function fetchBranch(runner: CommandRunner, branch: string): void {
  runner("git", [
    "fetch",
    "--no-tags",
    "--depth=1",
    "origin",
    `refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
}

// A stacked PR whose parent branch was deleted keeps a stale GITHUB_BASE_REF; fall back to main.
function fetchPullRequestBase(runner: CommandRunner, base: string): string {
  try {
    fetchBranch(runner, base);
    return `origin/${base}`;
  } catch (error) {
    if (base === "main") {
      throw error;
    }
    console.warn(`PR base '${base}' no longer exists on origin; falling back to origin/main`);
    fetchBranch(runner, "main");
    return "origin/main";
  }
}

export function resolveBaseRef(
  requestedBaseRef: string,
  environment: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = runCommand,
): string {
  let baseRef = requestedBaseRef;
  try {
    runner("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
  } catch {
    if (
      baseRef === "origin/main" &&
      environment.GITHUB_ACTIONS === "true" &&
      environment.GITHUB_BASE_REF
    ) {
      baseRef = fetchPullRequestBase(runner, environment.GITHUB_BASE_REF);
    }
    try {
      runner("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
    } catch {
      throw new Error(`Cannot check new host shell execution: base ref ${baseRef} does not exist.`);
    }
  }
  return baseRef;
}

export function resolveJjBaseRef(
  requestedBaseRef: string,
  runner: CommandRunner = runCommand,
): string {
  const baseRef = requestedBaseRef === "origin/main" ? "main@origin" : requestedBaseRef;
  try {
    runner("jj", ["log", "-r", baseRef, "--no-graph", "-T", ""]);
  } catch {
    throw new Error(`Cannot check new host shell execution: base ref ${baseRef} does not exist.`);
  }
  return baseRef;
}

export function changedSourceFiles(
  baseRef: string,
  hasGitDirectory = existsSync(".git"),
  hasJjDirectory = existsSync(".jj"),
  runner: CommandRunner = runCommand,
): string[] {
  if (!hasGitDirectory && !hasJjDirectory) {
    throw new Error(
      "Cannot check new host shell execution: this directory is not a Git or Jujutsu worktree.",
    );
  }
  const useJj = hasJjDirectory && !hasGitDirectory;
  const resolvedBaseRef = useJj
    ? resolveJjBaseRef(baseRef, runner)
    : resolveBaseRef(baseRef, process.env, runner);
  const changedFiles = useJj
    ? runner("jj", ["diff", "--from", resolvedBaseRef, "--to", "@", "--name-only", SOURCE_ROOT])
    : runner("git", ["diff", "--name-only", resolvedBaseRef, "--", SOURCE_ROOT]);
  return changedFiles.split("\n").filter((file) => file.endsWith(".ts") && existsSync(file));
}

const HOST_SHELL_ROW = BOUNDARY_ROWS.find((row) => row.id === "host-shell")!;

function readSource(path: string): string | undefined {
  return readFileSync(path, "utf8");
}

export function findViolations(baseRef = "origin/main"): BoundaryViolation[] {
  return scanBoundary(
    HOST_SHELL_ROW,
    changedSourceFiles(baseRef).map((path) => ({ path, addedLines: new Set<number>() })),
    { readSource },
  );
}

if (import.meta.main) {
  const result = renderBoundaryResult(HOST_SHELL_ROW, findViolations(process.argv[2]));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
