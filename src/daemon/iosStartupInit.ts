import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { CtrlProxyStaleRunnerCacheError } from "../utils/IOSCtrlProxyBuilder";

/** Options the startup path passes to `DeviceSessionManager.verifyIosDevice`. */
export interface IosStartupVerifyOptions {
  /** Startup never downloads: it only warms the cached runner (#7032). */
  skipCtrlProxyDownload: true;
  signal: AbortSignal;
}

/**
 * Narrow seams for {@link initializeIosCtrlProxyAtStartup}, so the daemon's
 * startup iOS init is testable with a FakeTimer and fakes instead of a real
 * `DeviceSessionManager` singleton and the static runner prefetch.
 */
export interface IosStartupInitDependencies {
  timer: Timer;
  /** Budget for the prefetch wait and for each device's verify. */
  perDeviceTimeoutMs: number;
  /** The in-flight runner-bundle prefetch, or null when none is pending. */
  pendingPrefetch: () => Promise<unknown> | null;
  verifyIosDevice: (deviceId: string, options: IosStartupVerifyOptions) => Promise<void>;
}

export interface IosStartupInitResult {
  /** Devices whose CtrlProxy is warm. */
  ready: string[];
  /** Devices whose setup was deliberately deferred to the first tool call. */
  deferred: string[];
}

function unrefTimeout(handle: NodeJS.Timeout): void {
  // Allow process to exit even if this timer is pending.
  if (typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }
}

/**
 * Wait for `pending` up to `timeoutMs` on the injected timer. Resolves true
 * when it settled in time, false on budget expiry.
 */
async function settledWithinBudget(
  pending: Promise<unknown>,
  timer: Timer,
  timeoutMs: number,
): Promise<boolean> {
  let handle: NodeJS.Timeout | undefined;
  const expired = new Promise<false>((resolve) => {
    handle = timer.setTimeout(() => resolve(false), timeoutMs);
    unrefTimeout(handle);
  });
  try {
    return await Promise.race([pending.then(() => true), expired]);
  } finally {
    if (handle !== undefined) {
      timer.clearTimeout(handle);
    }
  }
}

/**
 * Warm CtrlProxy on every startup-booted iOS device without racing the
 * background runner-bundle prefetch (#7032).
 *
 * Both startup paths touch the same extracted runner: the prefetch replaces a
 * one-release-old runner while this path (with downloads skipped) would verify
 * the cached one against the new registry hash and refuse it as tampering. So
 * an in-flight prefetch is awaited first under the same per-device budget; if
 * it is still running when the budget expires, setup is deferred to the first
 * tool call (which re-runs setup with downloads enabled), exactly as a failed
 * startup verify already did. A pre-launch refusal classified as a stale cache
 * is likewise deferred at info rather than warned as a failure.
 */
export async function initializeIosCtrlProxyAtStartup(
  deviceIds: string[],
  deps: IosStartupInitDependencies,
): Promise<IosStartupInitResult> {
  const result: IosStartupInitResult = { ready: [], deferred: [] };
  const pendingPrefetch = deps.pendingPrefetch();
  if (pendingPrefetch !== null) {
    logger.info(
      `[Daemon] CtrlProxy iOS runner prefetch in flight; waiting up to ${deps.perDeviceTimeoutMs}ms before verifying ${deviceIds.length} iOS device(s)`,
    );
    const landed = await settledWithinBudget(pendingPrefetch, deps.timer, deps.perDeviceTimeoutMs);
    if (!landed) {
      logger.info(
        `[Daemon] CtrlProxy iOS runner prefetch still in flight after ${deps.perDeviceTimeoutMs}ms; deferring CtrlProxy iOS setup for ${deviceIds.length} iOS device(s) to the first tool call`,
      );
      result.deferred.push(...deviceIds);
      return result;
    }
  }

  for (const deviceId of deviceIds) {
    logger.info(`[Daemon] Setting up CtrlProxy iOS for iOS device ${deviceId}`);
    const controller = new AbortController();
    const handle = deps.timer.setTimeout(() => {
      controller.abort(new Error(`Timeout after ${deps.perDeviceTimeoutMs}ms`));
    }, deps.perDeviceTimeoutMs);
    unrefTimeout(handle);
    try {
      await deps.verifyIosDevice(deviceId, {
        skipCtrlProxyDownload: true,
        signal: controller.signal,
      });
      logger.info(`[Daemon] CtrlProxy iOS ready for iOS device ${deviceId}`);
      result.ready.push(deviceId);
    } catch (error) {
      if (error instanceof CtrlProxyStaleRunnerCacheError) {
        // Expected on the first start after a version bump: the cached runner is
        // one release old and the first tool call re-runs setup with downloads.
        logger.info(
          `[Daemon] Deferring CtrlProxy iOS setup for ${deviceId} to the first tool call: ${error.message}`,
        );
        result.deferred.push(deviceId);
      } else {
        // Log but don't fail - service will be set up on first tool call if needed
        logger.warn(`[Daemon] Failed to initialize CtrlProxy iOS for ${deviceId}: ${error}`);
      }
    } finally {
      deps.timer.clearTimeout(handle);
    }
  }
  return result;
}
