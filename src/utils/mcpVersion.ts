import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

/**
 * Identity of the git commit a dev/source checkout is built from.
 * `shortSha` is the abbreviated commit hash; `dirty` flags uncommitted tracked changes.
 */
export interface GitVersionInfo {
  shortSha: string;
  dirty: boolean;
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

const readPackageVersionFromDisk = (): string | null => {
  const packagePath = findPackageJson(moduleDir()) ?? findPackageJson(process.cwd());
  if (!packagePath) {
    return null;
  }
  try {
    const raw = fs.readFileSync(packagePath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    // Unreadable/malformed package.json — fall through to unknown.
    return null;
  }
};

const runGit = (cwd: string, args: string[]): string | null => {
  try {
    const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 2000 });
    if (result.status !== 0 || result.error) {
      return null;
    }
    return result.stdout.trim();
  } catch {
    // git missing or not a checkout (release install) — no dev stamp.
    return null;
  }
};

/**
 * Read the current git commit identity from the package's checkout. Returns
 * null when git is unavailable or the package is not inside a working tree
 * (i.e. a published/release install), which keeps release versions unstamped.
 *
 * A published package lives under `node_modules`; `git rev-parse` searches
 * upward and would otherwise report the *host project's* commit, wrongly
 * stamping a release build. Treat any node_modules location as a release
 * install and skip git entirely.
 */
export const readGitVersion = (cwd: string = moduleDir()): GitVersionInfo | null => {
  if (cwd.split(path.sep).includes("node_modules")) {
    return null;
  }
  const shortSha = runGit(cwd, ["rev-parse", "--short=12", "HEAD"]);
  if (!shortSha) {
    return null;
  }
  // --untracked-files=no: only tracked changes alter the built code; untracked
  // scratch files should not flip a checkout to "dirty".
  const status = runGit(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  return { shortSha, dirty: status !== null && status.length > 0 };
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
  const dirty = git.dirty ? ".dirty" : "";
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
