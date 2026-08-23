import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Identity of a particular AutoMobile build.
 *
 * The daemon and the MCP frontend share one per-uid socket, so two checkouts on
 * the same machine (e.g. a worktree RC build + a main-repo build) can end up with
 * a daemon from one checkout serving a frontend from another. Both builds may
 * report the same package version (pre-release, package.json not bumped), so the
 * version string alone cannot detect the skew. A content hash of the entry script
 * can — that is what {@link BuildIdentity.buildId} carries.
 */
export interface BuildIdentity {
  /** Absolute path to the entry script (process.argv[1]) — "" when unknown. */
  entryScript: string;
  /** Short content hash of the entry script, or "unknown" when it cannot be read. */
  buildId: string;
}

/** Sentinel used when a build id cannot be computed. */
const UNKNOWN_BUILD_ID = "unknown";

function hashEntryScript(absolutePath: string): string {
  const content = readFileSync(absolutePath);
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Compute the {@link BuildIdentity} for an entry script.
 *
 * @param entryScript path to the entry script (typically process.argv[1])
 * @param hashFile injectable hasher (defaults to a sha256 of the file contents);
 *                 overridden in tests to avoid touching the filesystem
 */
export function computeBuildIdentity(
  entryScript: string | undefined,
  hashFile: (absolutePath: string) => string = hashEntryScript,
): BuildIdentity {
  if (!entryScript) {
    return { entryScript: "", buildId: UNKNOWN_BUILD_ID };
  }
  const absolute = resolve(entryScript);
  try {
    return { entryScript: absolute, buildId: hashFile(absolute) };
  } catch {
    // The entry script should always be readable; if it is not, fall back to an
    // unknown id rather than crashing the connection path. The entryScript path
    // is still recorded so callers can fall back to path identity.
    return { entryScript: absolute, buildId: UNKNOWN_BUILD_ID };
  }
}

let cachedIdentity: BuildIdentity | null = null;

/**
 * Identity of the currently running process's build. Cached after first use —
 * the entry script does not change while the process is alive.
 */
export function getCurrentBuildIdentity(): BuildIdentity {
  if (!cachedIdentity) {
    cachedIdentity = computeBuildIdentity(process.argv[1]);
  }
  return cachedIdentity;
}

function isKnownBuildId(buildId: string): boolean {
  return buildId.length > 0 && buildId !== UNKNOWN_BUILD_ID;
}

/**
 * Decide whether two builds are the same.
 *
 * - When both sides expose a known content hash, compare the hashes.
 * - When a hash is missing on one side, fall back to comparing the resolved entry
 *   script path.
 * - When neither side carries usable identity (e.g. a legacy daemon whose PID file
 *   predates build identity), treat it as a match so the frontend does not enter
 *   an endless restart loop against a daemon it cannot identify.
 */
export function buildIdentitiesMatch(a: BuildIdentity, b: BuildIdentity): boolean {
  if (isKnownBuildId(a.buildId) && isKnownBuildId(b.buildId)) {
    return a.buildId === b.buildId;
  }
  if (a.entryScript.length > 0 && b.entryScript.length > 0) {
    return a.entryScript === b.entryScript;
  }
  return true;
}

/**
 * Render a {@link BuildIdentity} as a single human-readable token:
 * `"<buildId> (<entryScript>)"`. Falls back to `unknown` for an empty entry
 * script so the rendering stays stable for legacy daemons that predate build
 * identity. Shared by `doctor` and the `--daemon status` CLI so both surface the
 * daemon's build in the same format.
 */
export function describeBuildIdentity(identity: BuildIdentity): string {
  return `${identity.buildId} (${identity.entryScript || "unknown"})`;
}

/**
 * Project the build fields carried on a daemon status / PID-file record into a
 * {@link BuildIdentity}, normalizing the optional wire fields (a missing
 * `entryScript` becomes `""`, a missing `buildId` becomes the unknown sentinel).
 *
 * Centralizes the `DaemonStatus`/`PidFileData` → `BuildIdentity` mapping that
 * `doctor`, the `--daemon status` CLI, and the MCP proxy all need, so they agree
 * on how an unidentified (legacy) daemon is represented. Accepts a structural
 * shape rather than importing `DaemonStatus` to avoid a module cycle and to keep
 * the surface narrow.
 */
export function buildIdentityFromStatus(record: {
  entryScript?: string;
  buildId?: string;
}): BuildIdentity {
  return {
    entryScript: record.entryScript ?? "",
    buildId: record.buildId ?? UNKNOWN_BUILD_ID,
  };
}
