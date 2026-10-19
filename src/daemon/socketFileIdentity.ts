import { existsSync, statSync } from "node:fs";
import { logger } from "../utils/logger";

/** Filesystem identity (device + inode) of a bound Unix socket file. */
export interface SocketFileIdentity {
  dev: number;
  ino: number;
}

export function readSocketFileIdentity(socketPath: string): SocketFileIdentity | null {
  try {
    const stats = statSync(socketPath);
    return { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    // statSync fails if the socket file was removed/replaced concurrently; callers
    // treat a null identity as "can't confirm ownership" rather than a hard error.
    logger.debug(`src/daemon/socketServer.ts fallback failed: ${error}`, error);
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
  return current?.dev === recorded.dev && current.ino === recorded.ino;
}
