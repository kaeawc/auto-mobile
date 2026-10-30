import { createConnection } from "node:net";
import { statSync } from "node:fs";
import { platform } from "node:os";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";

/**
 * Lightweight raw socket probe behind `DaemonClient.isAvailable`: no logging, no
 * DaemonClient overhead, and purely observation-only (issue #6140) -- it NEVER
 * unlinks the socket or PID file.
 */
export async function probeDaemonSocket(
  socketPath: string,
  options: { signal?: AbortSignal; timeoutMs?: number; timer?: Timer } = {},
): Promise<boolean> {
  const timer = options.timer ?? defaultTimer;
  // On Unix, verify the path exists and is a socket (not a stale regular file).
  // On Windows, named pipes don't have filesystem entries — skip the stat check
  // and let createConnection determine reachability.
  if (platform() !== "win32") {
    try {
      const stats = statSync(socketPath);
      if (!stats.isSocket()) {
        return false;
      }
    } catch (error) {
      // statSync throws when the path doesn't exist (or is unreadable); either way
      // there's no live daemon socket to connect to, so report unavailable.
      logger.debug(`src/daemon/client/client.ts fallback failed: ${error}`, error);
      return false;
    }
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (!settled) {
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        resolve(value);
      }
    };
    const onAbort = () => {
      timer.clearTimeout(timeout);
      socket.destroy();
      settle(false);
    };

    const socket = createConnection(socketPath, () => {
      timer.clearTimeout(timeout);
      socket.destroy();
      settle(true);
    });
    socket.on("error", () => {
      timer.clearTimeout(timeout);
      socket.destroy();
      settle(false);
    });
    const timeout = timer.setTimeout(() => {
      socket.destroy();
      settle(false);
    }, options.timeoutMs ?? 1000);
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }
  });
}
