import { beginPostActionCaptureAction } from "../../utils/PostActionCaptureContext";
import { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { LaunchApp } from "../action/LaunchApp";
import { PressButton } from "../action/PressButton";
import { awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { Timer } from "../../utils/SystemTimer";

const EXPLORE_LONG_SETTLE_MS = 2000;

/** Dispatches an internal tool call and throws when the tool reports failure. */
export type ExploreInternalToolCall = (
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<void>;

/** Device/session-aware recovery using the exploration's injected transport and clock. */
export class ExplorePlatformRecovery {
  constructor(
    private readonly device: BootedDevice,
    private readonly adb: AdbExecutor | undefined,
    private readonly timer: Timer,
    private readonly callInternalTool: ExploreInternalToolCall,
    private readonly sessionUuid?: string,
  ) {}

  async pressBack(signal?: AbortSignal): Promise<void> {
    if (this.device.platform === "android") {
      // Preserve the Explore instance's injected transport and timer. Calling
      // press() avoids nested observed-interaction progress on this operation.
      const result = await new PressButton(this.device, this.adb, this.timer).press("back", {
        signal,
      });
      if (!result.success) {
        throw new Error(result.error ?? "Android back navigation failed");
      }
      return;
    }
    // iOS recovery must route through the selected device/session tool.
    // Do not forward the outer progress callback: the nested action has a
    // different scale and would make exploration progress jump backward.
    await this.callInternalTool("pressButton", {
      button: "back",
      platform: this.device.platform,
      deviceId: this.device.deviceId,
      ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
    });
  }

  /**
   * Bring the target app back to the foreground after a home reset or app exit.
   *
   * This is a plain warm launchApp on purpose (no clearAppData, no coldBoot):
   * it recovers the foreground (issue #6126) with the platform's cheapest
   * launch. What "warm" means is launchApp's contract per platform — Android
   * and the iOS simulator foreground the existing process, while a physical
   * iOS device relaunches it because devicectl has no foreground verb.
   */
  async relaunch(packageName: string, signal?: AbortSignal): Promise<void> {
    if (this.device.platform === "android") {
      // Same injected transport and timer as the home press above.
      const result = await new LaunchApp(this.device, this.adb, null, this.timer).execute(
        packageName,
        { clearAppData: false, coldBoot: false, signal },
      );
      if (!result.success) {
        throw new Error(result.error ?? `Android relaunch of ${packageName} failed`);
      }
    } else {
      // Keep iOS recovery session/device-aware without nested progress.
      await this.callInternalTool(
        "launchApp",
        {
          appId: packageName,
          platform: this.device.platform,
          deviceId: this.device.deviceId,
          ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
        },
        signal,
      );
    }
  }
  async home(signal?: AbortSignal): Promise<void> {
    // Recovery dispatches below bypass BaseVisualChange's action boundary.
    await beginPostActionCaptureAction();
    if (this.device.platform === "android") {
      // PressButton's Android home path retains the injected ADB/timer and
      // performs the same accessibility-service then ADB fallback. Forward
      // Explore's AbortSignal (not just a remaining timeout) so a cancelled
      // exploration aborts the home dispatch and foreground-verification reads
      // rather than running them to completion (issue #6289).
      const result = await new PressButton(this.device, this.adb, this.timer).press("home", {
        signal,
      });
      if (!result.success) {
        throw new Error(result.error ?? "Android home navigation failed");
      }
    } else {
      // Keep iOS recovery session/device-aware without nested progress.
      await this.callInternalTool("homeScreen", {
        platform: this.device.platform,
        deviceId: this.device.deviceId,
        ...(this.sessionUuid ? { sessionUuid: this.sessionUuid } : {}),
      });
    }

    // Wait for home screen
    await awaitWhileRequestIsLive(this.timer.sleep(EXPLORE_LONG_SETTLE_MS), signal);
  }
}
