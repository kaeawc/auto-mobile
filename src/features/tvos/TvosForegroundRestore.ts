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

/** Launches an app on a tvOS simulator; `simctl launch` foregrounds an app that is already running. */
export type TvosAppActivator = (
  deviceId: string,
  bundleId: string,
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
    const launched = await this.dependencies.activate(deviceId, bundleId);
    if (!launched.success) {
      throw new ActionableError(
        `Could not bring ${bundleId} back to the foreground after the tvOS runner started: ` +
          `${launched.error ?? "simctl launch failed"}. Call launchApp to bring it to the front.`,
      );
    }
  }
}
