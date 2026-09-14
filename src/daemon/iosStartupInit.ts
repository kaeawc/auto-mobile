import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { CtrlProxyStaleRunnerCacheError } from "../utils/IOSCtrlProxyBuilder";

/** Options the startup path passes to `DeviceSessionManager.verifyIosDevice`. */
export interface IosStartupVerifyOptions {
  /** Startup never downloads: it only warms the cached runner (#7032). */
  skipCtrlProxyDownload: true;
  /**
   * Deliberately omitted for daemon warm-up: its foreground deadline must not
   * cancel the resident CtrlProxy startup that a later tool call can join.
   */
  signal?: AbortSignal;
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
  /** Devices whose startup continues beyond the foreground warm-up wait. */
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
 * it is still running when the budget expires, startup is deferred until the
 * first tool call. A slow per-device runner launch is allowed to continue in
 * the background so later callers can join it. A pre-launch refusal classified
 * as a stale cache is likewise deferred at info rather than warned as a failure.
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

  await Promise.all(
    deviceIds.map(async (deviceId) => {
      logger.info(`[Daemon] Setting up CtrlProxy iOS for iOS device ${deviceId}`);
      try {
        const verification = deps.verifyIosDevice(deviceId, {
          skipCtrlProxyDownload: true,
        });
        if (!(await settledWithinBudget(verification, deps.timer, deps.perDeviceTimeoutMs))) {
          // The runner is resident and may finish its provision-class startup after this
          // foreground warm-up wait. Do not abort it: that makes its shared-start logic
          // retire the runner and turns a slow healthy simulator into not_ready.
          logger.warn(
            `[Daemon] CtrlProxy iOS warm-up timed out for ${deviceId}: ` +
              `phase=runner-setup after ${deps.perDeviceTimeoutMs}ms; deferring to the resident startup`,
          );
          result.deferred.push(deviceId);
          void verification.then(
            () =>
              logger.info(
                `[Daemon] Deferred CtrlProxy iOS startup completed for ${deviceId} after warm-up timeout`,
              ),
            (error) =>
              logger.warn(
                `[Daemon] Deferred CtrlProxy iOS startup failed for ${deviceId}: ${errorMessage(error)}`,
                error,
              ),
          );
          return;
        }
        await verification;
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
      }
    }),
  );
  return result;
}
