import type { DaemonSocketReachabilityLike } from "./client/daemonSocketReachability";
import {
  classifySocketPath,
  type SocketFileIdentity,
  type SocketPathFs,
} from "./socketFileIdentity";
import { logger } from "../utils/logger";

const preservedProbeDecision = {
  answered: "held",
  unknown: "unknown",
} as const;

/**
 * On Windows an unreadable socket identity requires a second liveness probe immediately
 * before unlinking: it narrows (it cannot close) the window in which a successor binds
 * during the first probe. Only definite absence permits reclaim; inconclusive probes
 * preserve the endpoint on every platform.
 */
export async function decideStaleAuxSocketReclaim(deps: {
  socketPath: string;
  platform: NodeJS.Platform;
  reachability: DaemonSocketReachabilityLike;
  probeTimeoutMs: number;
  fs: SocketPathFs;
}): Promise<"absent" | "unlink" | "held" | "conflict" | "unknown"> {
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

  const result = await reachability.probe(socketPath, probeTimeoutMs);
  if (result !== "absent") {
    return preservedProbeDecision[result];
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
      const finalResult = await reachability.probe(socketPath, probeTimeoutMs);
      if (finalResult !== "absent") {
        return preservedProbeDecision[finalResult];
      }
      return fs.exists(socketPath) ? "unlink" : "absent";
  }
}
