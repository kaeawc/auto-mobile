import type { DaemonSocketReachabilityLike } from "./daemonSocketReachability";
import {
  classifySocketPath,
  type SocketFileIdentity,
  type SocketPathFs,
} from "./socketFileIdentity";
import { logger } from "../utils/logger";

/**
 * On Windows an unreadable socket identity requires a second liveness probe immediately
 * before unlinking: it narrows (it cannot close) the window in which a successor binds
 * during the first probe. "Nothing answered" is the same liveness signal POSIX uses.
 */
export async function decideStaleAuxSocketReclaim(deps: {
  socketPath: string;
  platform: NodeJS.Platform;
  reachability: DaemonSocketReachabilityLike;
  probeTimeoutMs: number;
  fs: SocketPathFs;
}): Promise<"absent" | "unlink" | "held" | "conflict"> {
  const { socketPath, platform, reachability, probeTimeoutMs, fs } = deps;
  if (!fs.exists(socketPath)) {
    return "absent";
  }

  let recorded: SocketFileIdentity | null = null;
  try {
    recorded = fs.stat(socketPath);
  } catch (error) {
    // Windows stat denial and concurrent removal are expected; classification preserves uncertainty.
    logger.debug(`Socket file identity unavailable at ${socketPath}: ${error}`, error);
  }

  const reachable = await reachability.isReachable(socketPath, probeTimeoutMs);
  if (reachable) {
    return "held";
  }
  if (!fs.exists(socketPath)) {
    return "absent";
  }

  const state = classifySocketPath(recorded, socketPath, fs);
  switch (state) {
    case "gone":
      return "absent";
    case "owned":
      return "unlink";
    case "replaced":
      return "conflict";
    case "unverifiable":
      if (platform !== "win32") {
        return "conflict";
      }
      if (await reachability.isReachable(socketPath, probeTimeoutMs)) {
        return "held";
      }
      return fs.exists(socketPath) ? "unlink" : "absent";
  }
}
