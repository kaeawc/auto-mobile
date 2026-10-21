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
