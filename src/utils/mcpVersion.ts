import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { logger } from "./logger";

/**
 * Identity of the git commit a dev/source checkout is built from.
 * `shortSha` is the abbreviated commit hash; `dirty` flags uncommitted tracked
 * changes; `dirtyHash` is a short content hash of those changes (null when clean)
 * so two checkouts at the same commit with *different* uncommitted edits report
 * different versions rather than colliding on a bare `.dirty` marker.
 */
export interface GitVersionInfo {
  shortSha: string;
  dirty: boolean;
  dirtyHash?: string | null;
}

/**
 * Injectable inputs for {@link resolveMcpServerVersion}. Keeps the resolution
 * logic pure and unit-testable without touching the filesystem, env, or git.
 */
export interface McpVersionDeps {
  env: { MCP_SERVER_VERSION?: string; npm_package_version?: string };
  readPackageVersion: () => string | null;
  readGitVersion: () => GitVersionInfo | null;
}

let cachedVersion: string | null = null;

const findPackageJson = (startDir: string): string | null => {
  let currentDir = startDir;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(currentDir, "package.json");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
  return null;
};

const moduleDir = (): string => path.dirname(fileURLToPath(import.meta.url));

/** The npm package name; used to confirm a git checkout is AutoMobile's own source repo. */
const PACKAGE_NAME = "@kaeawc/auto-mobile";

const readPackageName = (dir: string): string | null => {
  try {
    const raw = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
    return (JSON.parse(raw) as { name?: string }).name ?? null;
  } catch (error) {
    // This probe is best-effort; callers can safely use the fallback value.
    logger.debug(`src/utils/mcpVersion.ts fallback failed: ${error}`, error);
    return null;
  }
};

const readPackageVersionFromDisk = (): string | null => {
  const packagePath = findPackageJson(moduleDir()) ?? findPackageJson(process.cwd());
  if (!packagePath) {
    return null;
  }
  try {
    const raw = fs.readFileSync(packagePath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch (error) {
    // This probe is best-effort; callers can safely use the fallback value.
    logger.debug(`src/utils/mcpVersion.ts fallback failed: ${error}`, error);
    return null;
  }
};

/** Runs a git subcommand in `cwd` and returns trimmed stdout, or null on any failure. */
export type GitRunner = (cwd: string, args: string[]) => string | null;

const runGit: GitRunner = (cwd, args) => {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 2000 });
    if (result.status !== 0 || result.error) {
      return null;
    }
    return result.stdout.trim();
  } catch (error) {
    // This probe is best-effort; callers can safely use the fallback value.
    logger.debug(`src/utils/mcpVersion.ts fallback failed: ${error}`, error);
    return null;
  }
};

/**
 * Read the current git commit identity from the package's checkout. Returns
 * null when git is unavailable or this is not AutoMobile's own source checkout
 * (i.e. a published/release install), which keeps release versions unstamped.
 *
 * `git rev-parse` searches *upward* from the package directory, so a release
 * install vendored inside an unrelated git repo (or a `bunx`/global-cache layout
 * with no `node_modules` segment) would otherwise be stamped with the *host*
 * repo's commit. Two guards prevent that:
 *  1. Any `node_modules` location is a dependency install → skip.
 *  2. The enclosing repo's top-level `package.json` must be this package — i.e.
 *     the checkout is AutoMobile's source repo, not a host project that merely
 *     contains a copy.
 */
export const readGitVersion = (
  cwd: string = moduleDir(),
  run: GitRunner = runGit,
  readName: (dir: string) => string | null = readPackageName,
): GitVersionInfo | null => {
  // Split on both separators — Windows paths use `\`, but git/bun can emit `/`
  // even there, so a single `path.sep` split would miss the node_modules segment.
  if (cwd.split(/[\\/]/).includes("node_modules")) {
    return null;
  }
  const toplevel = run(cwd, ["rev-parse", "--show-toplevel"]);
  if (!toplevel || readName(toplevel) !== PACKAGE_NAME) {
    return null;
  }
  const shortSha = run(cwd, ["rev-parse", "--short=12", "HEAD"]);
  if (!shortSha) {
    return null;
  }
  // --untracked-files=no: only tracked changes alter the built code; untracked
  // scratch files should not flip a checkout to "dirty".
  const status = run(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  const dirty = status !== null && status.length > 0;
  // When dirty, hash the actual tracked diff so two checkouts at the same commit
  // with different uncommitted edits get distinct stamps (a bare boolean would
  // collide). Falls back to the plain `.dirty` marker if the diff is unavailable.
  let dirtyHash: string | null = null;
  if (dirty) {
    const diff = run(cwd, ["diff", "HEAD"]);
    if (diff) {
      dirtyHash = createHash("sha256").update(diff).digest("hex").slice(0, 12);
    }
  }
  return { shortSha, dirty, dirtyHash };
};

/**
 * The release portion of a version string — everything before the first `+`
 * (semver build metadata). Dev/non-release builds carry a `+g<sha>[.dirty]`
 * stamp; consumers that compare or parse versions numerically (the daemon
 * version gate, plan migration) must strip it first. This is the one canonical
 * place that knows the stamp format.
 */
export const releaseVersion = (version: string): string => version.split("+")[0];

/**
 * Stamp a git short SHA (and dirty marker) onto a base version as semver build
 * metadata. Release builds (no git info) are returned unchanged.
 *
 * The `+` separator keeps the release portion (before `+`) intact so numeric
 * comparisons still work once {@link releaseVersion} strips the metadata, while
 * the full string still varies per commit for diagnostics (doctor, logs,
 * `DaemonVersionMismatchError`).
 */
export const formatMcpServerVersion = (baseVersion: string, git: GitVersionInfo | null): string => {
  if (!git || git.shortSha.length === 0) {
    return baseVersion;
  }
  // Dirty suffix: `.dirty` for the human marker, plus the tracked-diff hash when
  // available so distinct working trees at the same commit don't collide.
  const dirty = git.dirty ? (git.dirtyHash ? `.dirty.${git.dirtyHash}` : ".dirty") : "";
  return `${baseVersion}+g${git.shortSha}${dirty}`;
};

/**
 * Resolve the effective MCP server version from injected inputs.
 *
 * - An explicit `MCP_SERVER_VERSION` is an exact override (CI/test pin) and is
 *   never stamped.
 * - Otherwise the base version comes from `npm_package_version` or package.json,
 *   and is stamped with the git commit when the build is a source checkout.
 * - With no resolvable base version, returns "unknown" (unstamped).
 */
export const resolveMcpServerVersion = (deps: McpVersionDeps): string => {
  const override = deps.env.MCP_SERVER_VERSION;
  if (override) {
    return override;
  }

  const base = deps.env.npm_package_version || deps.readPackageVersion() || "unknown";
  if (base === "unknown") {
    return base;
  }

  return formatMcpServerVersion(base, deps.readGitVersion());
};

export const getMcpServerVersion = (): string => {
  if (cachedVersion) {
    return cachedVersion;
  }

  cachedVersion = resolveMcpServerVersion({
    env: {
      MCP_SERVER_VERSION: process.env.MCP_SERVER_VERSION,
      npm_package_version: process.env.npm_package_version,
    },
    readPackageVersion: readPackageVersionFromDisk,
    readGitVersion: () => readGitVersion(),
  });
  return cachedVersion;
};
