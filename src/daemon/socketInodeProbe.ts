import { statSync } from "node:fs";
import { logger } from "../utils/logger";

/**
 * Identity of a filesystem inode, sufficient to detect a path being replaced by a
 * different file (issue #6140 TOCTOU): a socket path is a plain filename, so
 * `unlink`-then-`bind` by a concurrent process reuses the same path with a brand
 * new inode. Comparing `{dev, ino}` (not just `existsSync`) is what lets recovery
 * tell "still the exact stale socket I checked" apart from "a live winner already
 * replaced it with a new one at the same path".
 */
export interface SocketInodeIdentity {
  dev: number;
  ino: number;
}

/**
 * The narrow contract {@link DaemonClient.connect}'s stale-socket recovery depends
 * on to make the "confirmed no live holder" check atomic with the eventual unlink
 * (issue #6140 TOCTOU): between {@link SocketHolderProbe.getHolderPids} sampling no
 * live holder and the actual unlink, a concurrent startup winner can unlink the
 * stale socket and bind a NEW one at the same path — `cleanupStaleSocketIfDaemonDead`
 * only re-checks the PID file (still the dead loser), so it would delete the
 * winner's live socket. Capturing the inode identity before the (async) holder
 * probe and re-comparing immediately before authorizing the unlink closes that
 * window.
 */
export interface SocketInodeProbe {
  /** Returns the path's current `{dev, ino}`, or `undefined` if it cannot be stat'd (missing, permission, etc). */
  statSocket(socketPath: string): SocketInodeIdentity | undefined;
}

/**
 * Whether `current` is confirmed to be the SAME inode as `captured` — i.e. safe to
 * treat as "still the exact stale socket verified to have no live holder".
 *
 * `undefined` on both sides (the path did not exist at either stat) is treated as a
 * match: there is nothing at the path to accidentally unlink out from under a live
 * winner either way, and the downstream cleanup already no-ops for a missing socket
 * path while still removing the stale PID file (issue #6140). A path that appeared
 * or disappeared between the two stats is ambiguous and is NOT treated as a match —
 * recovery must stay non-destructive rather than guess.
 */
export function sameSocketInode(
  captured: SocketInodeIdentity | undefined,
  current: SocketInodeIdentity | undefined,
): boolean {
  if (captured === undefined && current === undefined) {
    return true;
  }
  if (captured === undefined || current === undefined) {
    return false;
  }
  return captured.dev === current.dev && captured.ino === current.ino;
}

/** `SocketInodeProbe` backed by a real synchronous `fs.statSync`. */
export class FsSocketInodeProbe implements SocketInodeProbe {
  statSocket(socketPath: string): SocketInodeIdentity | undefined {
    try {
      const stats = statSync(socketPath);
      return { dev: stats.dev, ino: stats.ino };
    } catch (error) {
      // A missing/unreadable path just means there is nothing here to compare
      // against later — the caller's `sameSocketInode` handles that case.
      logger.debug(`[DaemonClient] socket inode stat failed for ${socketPath}: ${error}`, error);
      return undefined;
    }
  }
}

/**
 * A single lazily-constructed default probe, shared across instances that don't
 * inject their own (mirrors the other stale-socket-recovery default singletons in
 * `client.ts`).
 */
export const defaultSocketInodeProbe: SocketInodeProbe = new FsSocketInodeProbe();
