import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { sleepUnlessAborted } from "../deviceLifecycle/core/deadlines";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { VisionosTargetApps } from "../visionos/VisionosTargetApps";

/**
 * Brings the app under test back in front after the runner starts (#18020). Launching the runner
 * foregrounds its own host app, so without this the next command reads the host app instead of
 * the app the session launched.
 */
export interface TvosForegroundRestore {
  restore(deviceId: string, signal?: AbortSignal): Promise<void>;
}

/**
 * Launches an app on a tvOS simulator; `simctl launch` foregrounds an app that is already running.
 * Aborting `signal` must stop the launch (the production adapter kills the `simctl` child), so a
 * lifecycle cancellation does not wait out the launch timeout (#18115).
 */
export type TvosAppActivator = (
  deviceId: string,
  bundleId: string,
  signal?: AbortSignal,
) => Promise<{ success: boolean; error?: string }>;

/**
 * Reads the bundle id the runner reports in front (its hierarchy's `packageName`), or undefined
 * when no runner can answer yet.
 */
export type TvosForegroundProbe = (
  deviceId: string,
  signal?: AbortSignal,
) => Promise<string | undefined>;

/** How long the restore waits for the app to reach the foreground after `simctl launch` returns. */
export const TVOS_FOREGROUND_SETTLE_TIMEOUT_MS = 5_000;
export const TVOS_FOREGROUND_POLL_INTERVAL_MS = 250;

/** Re-launches the device's last-launched app, when there is one. */
export class TargetAppForegroundRestore implements TvosForegroundRestore {
  constructor(
    private readonly dependencies: {
      targetApps: Pick<VisionosTargetApps, "get">;
      activate: TvosAppActivator;
      /**
       * `simctl launch` returns before tvOS finishes the transition (#18020), so the restore waits
       * until the runner sees the app in front. Without a probe it returns after the launch.
       */
      foreground?: TvosForegroundProbe;
      timer?: Timer;
      settleTimeoutMs?: number;
      pollIntervalMs?: number;
    },
  ) {}

  async restore(deviceId: string, signal?: AbortSignal): Promise<void> {
    const bundleId = this.dependencies.targetApps.get(deviceId);
    if (bundleId === undefined) {
      return;
    }
    signal?.throwIfAborted();
    const launched = await this.dependencies.activate(deviceId, bundleId, signal);
    if (!launched.success) {
      // A launch killed by the abort reports a plain failure; surface the cancellation instead.
      signal?.throwIfAborted();
      throw new ActionableError(
        `Could not bring ${bundleId} back to the foreground after the tvOS runner started: ` +
          `${launched.error ?? "simctl launch failed"}. Call launchApp to bring it to the front.`,
      );
    }
    await this.awaitForeground(deviceId, bundleId, signal);
  }

  private async awaitForeground(
    deviceId: string,
    bundleId: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const probe = this.dependencies.foreground;
    if (!probe) {
      return;
    }
    const timer = this.dependencies.timer ?? defaultTimer;
    const timeoutMs = this.dependencies.settleTimeoutMs ?? TVOS_FOREGROUND_SETTLE_TIMEOUT_MS;
    const intervalMs = this.dependencies.pollIntervalMs ?? TVOS_FOREGROUND_POLL_INTERVAL_MS;
    const deadline = timer.now() + timeoutMs;
    let lastSeen: string | undefined;
    for (;;) {
      signal?.throwIfAborted();
      lastSeen = await this.readForeground(probe, deviceId, signal);
      if (lastSeen === bundleId) {
        return;
      }
      const remainingMs = deadline - timer.now();
      if (remainingMs <= 0) {
        break;
      }
      await sleepUnlessAborted(timer, Math.min(intervalMs, remainingMs), signal);
    }
    throw new ActionableError(
      `${bundleId} was not in front within ${timeoutMs} ms after the tvOS runner started ` +
        `(in front: ${lastSeen ?? "unknown"}). Call observe again, or launchApp to bring it to the front.`,
    );
  }

  private async readForeground(
    probe: TvosForegroundProbe,
    deviceId: string,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    try {
      return await probe(deviceId, signal);
    } catch (error) {
      signal?.throwIfAborted();
      // A hierarchy read can fail while the app is still coming up; the next poll retries it.
      logger.debug(`[TvosRunner] foreground probe on ${deviceId} failed: ${errorMessage(error)}`);
      return undefined;
    }
  }
}
