import { ActionableError } from "../../models/ActionableError";
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

/** Re-launches the device's last-launched app, when there is one. */
export class TargetAppForegroundRestore implements TvosForegroundRestore {
  constructor(
    private readonly dependencies: {
      targetApps: Pick<VisionosTargetApps, "get">;
      activate: TvosAppActivator;
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
  }
}
