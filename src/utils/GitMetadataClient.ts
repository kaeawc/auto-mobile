import { createHash } from "crypto";
import { spawnSync } from "child_process";

export interface GitVersionInfo {
  shortSha: string;
  dirty: boolean;
  dirtyHash?: string | null;
}

export interface GitCommandOptions {
  cwd: string;
  timeoutMs: number;
}

/** Injectable synchronous argv boundary for git metadata probes. */
export type GitCommandRunner = (
  command: "git",
  args: readonly string[],
  options: GitCommandOptions,
) => string | null;

export interface GitMetadataClient {
  readVersion(
    cwd: string,
    readPackageName: (directory: string) => string | null,
  ): GitVersionInfo | null;
}

const PACKAGE_NAME = "@kaeawc/auto-mobile";
const GIT_TIMEOUT_MS = 2_000;

const defaultRunner: GitCommandRunner = (_command, args, { cwd, timeoutMs }) => {
  let result: ReturnType<typeof spawnSync> | null = null;
  try {
    result = spawnSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
    });
  } catch (error) {
    // Version probing runs before logger initialization; metadata is optional.
    void error;
  }
  if (!result || result.status !== 0 || result.error) {
    return null;
  }
  return (typeof result.stdout === "string" ? result.stdout : result.stdout.toString()).trim();
};

/**
 * Owns synchronous git metadata probing. All commands use argv, a bounded
 * timeout, and SIGTERM cleanup; unavailable or non-repository environments
 * produce no metadata rather than making version discovery fail.
 */
export class DefaultGitMetadataClient implements GitMetadataClient {
  constructor(private readonly run: GitCommandRunner = defaultRunner) {}

  readVersion(
    cwd: string,
    readPackageName: (directory: string) => string | null,
  ): GitVersionInfo | null {
    // A dependency install must not inherit the host repository's revision.
    if (cwd.split(/[\\/]/).includes("node_modules")) {
      return null;
    }

    const toplevel = this.execute(cwd, ["rev-parse", "--show-toplevel"]);
    if (!toplevel || readPackageName(toplevel) !== PACKAGE_NAME) {
      return null;
    }

    // Detached HEAD has a resolvable commit and intentionally needs no branch probe.
    const shortSha = this.execute(cwd, ["rev-parse", "--short=12", "HEAD"]);
    if (!shortSha) {
      return null;
    }

    const status = this.execute(cwd, ["status", "--porcelain", "--untracked-files=no"]);
    const dirty = status !== null && status.length > 0;
    let dirtyHash: string | null = null;
    if (dirty) {
      const diff = this.execute(cwd, ["diff", "HEAD"]);
      if (diff) {
        dirtyHash = createHash("sha256").update(diff).digest("hex").slice(0, 12);
      }
    }
    return { shortSha, dirty, dirtyHash };
  }

  private execute(cwd: string, args: readonly string[]): string | null {
    return this.run("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  }
}

export const defaultGitMetadataClient = new DefaultGitMetadataClient();
