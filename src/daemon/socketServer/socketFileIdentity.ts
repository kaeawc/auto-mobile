import { existsSync, statSync } from "node:fs";
import { logger } from "../../utils/logger";
import type { SocketFileIdentity } from "../socketServer";

/** The device and inode of the socket file at `socketPath`, or null when it cannot be read. */
export function readSocketFileIdentity(socketPath: string): SocketFileIdentity | null {
  try {
    const stats = statSync(socketPath);
    return { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    // statSync fails if the socket file was removed/replaced concurrently; callers
    // treat a null identity as "can't confirm ownership" rather than a hard error.
    logger.debug(`socket file identity unreadable at ${socketPath}: ${error}`, error);
    return null;
  }
}

/** Whether the file now at `socketPath` is the one this server bound (same device and inode). */
export function isOwnedSocketFile(
  socketPath: string,
  boundIdentity: SocketFileIdentity | null,
): boolean {
  if (!boundIdentity || !existsSync(socketPath)) {
    return false;
  }
  const currentIdentity = readSocketFileIdentity(socketPath);
  return currentIdentity?.dev === boundIdentity.dev && currentIdentity.ino === boundIdentity.ino;
}
