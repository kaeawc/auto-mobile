import {
  pendingImeRestores,
  type PendingImeRestoreRegistry,
} from "../features/action/sendkeys/PendingImeRestore";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";

/**
 * Restore every keyboard the AutoMobile IME still replaces, best-effort, when the daemon stops
 * gracefully (#17768). Session release already flushed its own device; what is left here is a
 * sessionless `sendKeys` or a release that could not restore. A failure is logged and never
 * thrown, and the bound aborts restores still waiting for or running under the IME lock.
 */
export async function restorePendingImesForShutdown(
  timer: Pick<Timer, "setTimeout" | "clearTimeout">,
  timeoutMs: number,
  registry: Pick<PendingImeRestoreRegistry, "pendingDeviceIds" | "flush"> = pendingImeRestores,
): Promise<void> {
  const deviceIds = registry.pendingDeviceIds();
  if (deviceIds.length === 0) {
    return;
  }
  const bound = new AbortController();
  const handle = timer.setTimeout(
    () => bound.abort(new Error(`IME restore exceeded its ${timeoutMs}ms shutdown bound`)),
    timeoutMs,
  );
  try {
    const results = await Promise.allSettled(
      deviceIds.map((deviceId) => registry.flush(deviceId, { signal: bound.signal })),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        logger.warn(
          `[SendKeys] Shutdown IME restoration failed on ${deviceIds[index]}`,
          result.reason,
        );
      }
    }
  } finally {
    timer.clearTimeout(handle);
  }
}
