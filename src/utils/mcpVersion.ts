import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { testOverrides } from "./testOverrides";
import { tryOrElse } from "../models/tryOrElse";
import {
  defaultGitMetadataClient,
  type GitMetadataClient,
  type GitVersionInfo,
  type GitDirtyState,
} from "./GitMetadataClient";
import { AMBIENT_ENV, readEnvRaw } from "../config/env";
import { defaultTimer, type Timer } from "./SystemTimer";
import { logger } from "./logger";

export type { GitVersionInfo } from "./GitMetadataClient";

/**
 * Identity of the git commit a dev/source checkout is built from.
 * `shortSha` is the abbreviated commit hash; `dirty` flags uncommitted tracked
 * changes; `dirtyHash` is a short content hash of those changes (null when clean)
 * so two checkouts at the same commit with *different* uncommitted edits report
 * different versions rather than colliding on a bare `.dirty` marker.
 */
/**
 * Injectable inputs for {@link resolveMcpServerVersion}. Keeps the resolution
 * logic pure and unit-testable without touching the filesystem, env, or git.
 */
export interface McpVersionDeps {
  env: { MCP_SERVER_VERSION?: string; npm_package_version?: string };
  readPackageVersion: () => string | null;
  readGitVersion: () => GitVersionInfo | null;
}

export interface McpVersionResolverDeps extends McpVersionDeps {
  timer: Pick<Timer, "setTimeout">;
  readDirtyState: () => Promise<GitDirtyState | null>;
}

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

const readPackageName = (dir: string): string | null => {
  // Version probing runs before logger setup; fall back to unstamped metadata.
  return tryOrElse(
    () => {
      const raw = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
      return (JSON.parse(raw) as { name?: string }).name ?? null;
    },
    () => null,
  );
};

const readPackageVersionFromDisk = (): string | null => {
  const packagePath = findPackageJson(moduleDir()) ?? findPackageJson(process.cwd());
  if (!packagePath) {
    return null;
  }
  // Version probing runs before logger setup; fall back to other version sources.
  return tryOrElse(
    () => {
      const raw = fs.readFileSync(packagePath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: string };
      return parsed.version ?? null;
    },
    () => null,
  );
};

/**
 * Read the current git commit identity from the package's checkout. Returns
 * null when git is unavailable or this is not AutoMobile's own source checkout
 * (i.e. a published/release install), which keeps release versions unstamped.
 *
 * Repository discovery searches *upward* from the package directory, so a release
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
  client: GitMetadataClient = defaultGitMetadataClient,
  readName: (dir: string) => string | null = readPackageName,
): GitVersionInfo | null => client.readVersion(cwd, readName);

/**
 * The release portion of a version string — everything before the first `+`
 * (semver build metadata). Dev/non-release builds carry a `+g<sha>[.dirty]`
 * stamp; consumers that compare or parse versions numerically (the daemon
 * version gate, plan migration) must strip it first. This is the one canonical
 * place that knows the stamp format.
 */
export const releaseVersion = (version: string): string => version.split("+")[0];

/** Remove a trailing working-tree stamp only from git build metadata (+g<sha>). */
export const withoutDirtyStamp = (version: string): string =>
  version.replace(/(\+g[\da-f]+)\.dirty(?:\.[\da-f]+)?$/i, "$1");

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
 * - Otherwise the base version comes from package.json, falling back to
 *   `npm_package_version` only when the manifest version is unavailable,
 *   and is stamped with the git commit when the build is a source checkout.
 * - With no resolvable base version, returns "unknown" (unstamped).
 */
export const resolveMcpServerVersion = (deps: McpVersionDeps): string => {
  const override = deps.env.MCP_SERVER_VERSION;
  if (override) {
    return override;
  }

  const base = deps.readPackageVersion() || deps.env.npm_package_version || "unknown";
  if (base === "unknown") {
    return base;
  }

  return formatMcpServerVersion(base, deps.readGitVersion());
};

/** Cache the startup stamp and refine tracked edits once, off the startup path. */
export const createMcpVersionResolver = (
  deps: McpVersionResolverDeps,
): { current(): string; isSettled(): boolean; resolveSettled(): Promise<string> } => {
  let cachedVersion: string | null = null;
  let refine: (() => Promise<void>) | undefined;
  let refinement: Promise<void> | undefined;
  let refined = false;
  const startRefinement = (): Promise<void> => (refinement ??= refine?.() ?? Promise.resolve());
  return {
    current() {
      if (cachedVersion !== null) {
        return cachedVersion;
      }
      const override = deps.env.MCP_SERVER_VERSION;
      if (override) {
        cachedVersion = override;
        return cachedVersion;
      }
      const base = deps.readPackageVersion() || deps.env.npm_package_version || "unknown";
      const git = base === "unknown" ? null : deps.readGitVersion();
      cachedVersion = formatMcpServerVersion(base, git);
      if (git) {
        refine = async (): Promise<void> => {
          try {
            const state = await deps.readDirtyState();
            if (state?.dirty) {
              cachedVersion = formatMcpServerVersion(base, { ...git, ...state });
            }
          } catch (error) {
            logger.warn("Background git dirty-state resolution failed", error);
          } finally {
            refined = true;
          }
        };
        deps.timer.setTimeout(() => void startRefinement(), 0);
      }
      return cachedVersion;
    },
    /** True once current() can no longer change: no refinement is due, or it has finished. */
    isSettled() {
      this.current();
      return refine === undefined || refined;
    },
    async resolveSettled() {
      this.current();
      // Explicit identity consumers cannot rely on an unref'ed timer keeping the
      // process alive. Start (or join) the same asynchronous probe immediately.
      await startRefinement();
      return this.current();
    },
  };
};

let resolver: ReturnType<typeof createMcpVersionResolver> | undefined;

const defaultResolverDeps = (): McpVersionResolverDeps => ({
  env: {
    MCP_SERVER_VERSION: readEnvRaw(AMBIENT_ENV.MCP_SERVER_VERSION),
    npm_package_version: readEnvRaw(AMBIENT_ENV.NPM_PACKAGE_VERSION),
  },
  readPackageVersion: readPackageVersionFromDisk,
  readGitVersion: () => readGitVersion(moduleDir(), testOverrides.gitMetadataClient),
  readDirtyState: () =>
    (testOverrides.gitMetadataClient ?? defaultGitMetadataClient).readDirtyState(moduleDir()),
  timer: {
    setTimeout(callback, ms) {
      const handle = defaultTimer.setTimeout(callback, ms);
      handle.unref?.();
      return handle;
    },
  },
});

const getResolver = (): ReturnType<typeof createMcpVersionResolver> =>
  (resolver ??= createMcpVersionResolver(defaultResolverDeps()));

/** Probe the version a process started from this checkout right now would report. */
export const probeCheckoutMcpServerVersion = (): Promise<string> =>
  createMcpVersionResolver(defaultResolverDeps()).resolveSettled();

export const getMcpServerVersion = (): string => getResolver().current();

/** Whether {@link getMcpServerVersion} already returns its final (dirty-aware) value. */
export const isMcpServerVersionSettled = (): boolean => getResolver().isSettled();

/** Await the same one-shot refinement used by normal background discovery. */
export const getSettledMcpServerVersion = (): Promise<string> => getResolver().resolveSettled();
