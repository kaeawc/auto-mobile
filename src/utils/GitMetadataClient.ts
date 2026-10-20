import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

/** Synchronous, read-only boundary; absent paths return null. */
export interface GitMetadataReader {
  kind(path: string): "file" | "directory" | null;
  readFile(path: string): string | null;
}

const defaultReader: GitMetadataReader = {
  kind(path) {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat?.isDirectory() ? "directory" : stat?.isFile() ? "file" : null;
  },
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      // Missing optional metadata is normal; other failures trigger the git fallback.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  },
};

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
  constructor(
    private readonly run: GitCommandRunner = defaultRunner,
    private readonly fs: GitMetadataReader = defaultReader,
  ) {}

  readVersion(
    cwd: string,
    readPackageName: (directory: string) => string | null,
  ): GitVersionInfo | null {
    // A dependency install must not inherit the host repository's revision.
    if (cwd.split(/[\\/]/).includes("node_modules")) {
      return null;
    }

    const toplevel = this.findRoot(cwd);
    if (!toplevel || readPackageName(toplevel) !== PACKAGE_NAME) {
      return null;
    }

    const sha = this.readHead(toplevel) ?? this.execute(cwd, ["rev-parse", "HEAD"]);
    if (!sha) {
      return null;
    }
    // Fixed 12 characters avoid git's expensive pack-index uniqueness lookup.
    // Unlike --short=12, this does not lengthen an astronomically rare collision.
    const shortSha = sha.slice(0, 12);

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

  private findRoot(cwd: string): string | null {
    try {
      let directory = resolve(cwd);
      while (true) {
        if (this.fs.kind(join(directory, ".git"))) {
          return directory;
        }
        const parent = dirname(directory);
        if (parent === directory) {
          return null;
        }
        directory = parent;
      }
    } catch (error) {
      // Version probing is optional and runs before logger initialization.
      void error;
      return null;
    }
  }

  private resolveGitdir(root: string): string | null {
    const dotgit = join(root, ".git");
    if (this.fs.kind(dotgit) === "directory") {
      return dotgit;
    }
    const gitfile = this.fs.readFile(dotgit)?.replace(/\r?\n$/, "");
    if (!gitfile?.startsWith("gitdir: ") || /[\r\n\0]/.test(gitfile)) {
      return null;
    }
    const target = gitfile.slice("gitdir: ".length);
    return target ? resolve(root, target) : null;
  }

  private resolveCommondir(gitdir: string): string | null {
    const common = this.fs.readFile(join(gitdir, "commondir"));
    if (common === null) {
      return gitdir;
    }
    const target = common.replace(/\r?\n$/, "");
    return target && !/[\r\n\0]/.test(target) ? resolve(gitdir, target) : null;
  }

  private isValidRef(ref: string): boolean {
    // Ref names are git's text format, not paths supplied to a general parser.
    return (
      ref.startsWith("refs/") &&
      !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref) &&
      !ref.includes("..") &&
      !ref.includes("@{") &&
      !ref.endsWith(".") &&
      ref.split("/").every((part) => !!part && !part.startsWith(".") && !part.endsWith(".lock"))
    );
  }

  private readRef(gitdir: string, commondir: string, ref: string): string | null {
    // These namespaces are per-worktree; ordinary refs live in the common dir.
    const refdir = /^refs\/(bisect|worktree|rewritten)\//.test(ref) ? gitdir : commondir;
    const loose = this.fs.readFile(join(refdir, ref));
    if (loose !== null) {
      return loose.trim();
    }
    const packed = this.fs.readFile(join(refdir, "packed-refs"));
    const entry = packed?.split(/\r?\n/).find((line) => line.endsWith(` ${ref}`));
    const record = entry?.match(/^([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/);
    return record?.[2] === ref ? record[1] : null;
  }

  private resolveHead(gitdir: string, commondir: string): string | null {
    let value = this.fs.readFile(join(gitdir, "HEAD"))?.trim();
    const seen = new Set<string>();
    while (value?.startsWith("ref: ")) {
      const ref = value.slice("ref: ".length);
      if (!this.isValidRef(ref) || seen.has(ref) || seen.size >= 32) {
        return null;
      }
      seen.add(ref);
      value = this.readRef(gitdir, commondir, ref) ?? undefined;
    }
    return value && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) && !/^0+$/.test(value)
      ? value
      : null;
  }

  private readHead(root: string): string | null {
    try {
      const gitdir = this.resolveGitdir(root);
      if (!gitdir) {
        return null;
      }
      const commondir = this.resolveCommondir(gitdir);
      // Reftable is deliberately left to git, including transitional mixed layouts.
      if (!commondir || this.fs.kind(join(commondir, "reftable"))) {
        return null;
      }
      return this.resolveHead(gitdir, commondir);
    } catch (error) {
      // Optional metadata may be unreadable or unsupported; let git resolve HEAD.
      void error;
      return null;
    }
  }

  private execute(cwd: string, args: readonly string[]): string | null {
    return this.run("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  }
}

export const defaultGitMetadataClient = new DefaultGitMetadataClient();
