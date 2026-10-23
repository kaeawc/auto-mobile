import { existsSync, statSync } from "node:fs";
import { logger } from "../utils/logger";

/**
 * Filesystem identity (device + inode) of a bound socket or daemon file. Both are bigints:
 * NTFS volume serials and file IDs exceed 2^53, and as numbers two distinct files can round
 * to the same identity (#14644 fixed the same loss in the lock protocol).
 */
export interface SocketFileIdentity {
  dev: bigint;
  ino: bigint;
}

/** The exact identity of the file at `path`; throws when it cannot be stat'ed. */
export function statFileIdentity(path: string): SocketFileIdentity {
  const { dev, ino } = statSync(path, { bigint: true });
  return { dev, ino };
}

export function sameFileIdentity(left: SocketFileIdentity, right: SocketFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export type SocketPathState = "owned" | "gone" | "replaced" | "unverifiable";

export interface SocketPathFs {
  exists(path: string): boolean;
  stat(path: string): SocketFileIdentity;
}

/** Distinguish a successor's path from a bound socket whose identity cannot be read. */
export function classifySocketPath(
  recorded: SocketFileIdentity | null,
  socketPath: string,
  fs: SocketPathFs = { exists: existsSync, stat: statFileIdentity },
): SocketPathState {
  if (!fs.exists(socketPath)) {
    return "gone";
  }
  try {
    const current = fs.stat(socketPath);
    return recorded !== null && sameFileIdentity(current, recorded) ? "owned" : "replaced";
  } catch (error) {
    // An unreadable bound socket is expected on Windows; preserve uncertainty when
    // no bind identity exists, but never assume ownership after losing a known identity.
    logger.debug(`Socket path identity unavailable at ${socketPath}: ${error}`, error);
    if (recorded !== null) {
      return "replaced";
    }
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
    return code === "ENOENT" || code === "ENOTDIR" ? "gone" : "unverifiable";
  }
}

export function readSocketFileIdentity(socketPath: string): SocketFileIdentity | null {
  try {
    return statFileIdentity(socketPath);
  } catch (error) {
    // statSync fails if the socket file was removed/replaced concurrently; callers
    // treat a null identity as "can't confirm ownership" rather than a hard error.
    logger.debug(`Socket file identity unavailable at ${socketPath}: ${error}`, error);
    return null;
  }
}

/** True when the file now at `socketPath` is the one whose identity was recorded at bind time. */
export function isOwnedSocketFile(
  recorded: SocketFileIdentity | null,
  socketPath: string,
): boolean {
  if (!recorded || !existsSync(socketPath)) {
    return false;
  }
  const current = readSocketFileIdentity(socketPath);
  return current !== null && sameFileIdentity(current, recorded);
}
