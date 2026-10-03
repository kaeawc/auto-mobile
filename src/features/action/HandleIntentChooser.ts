import { throwIfAborted } from "../../utils/toolUtils";
import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import { DeepLinkManager } from "../utility/DeepLinkManager";
import { BootedDevice, IntentChooserResult, ObserveResult } from "../../models";
import { BaseVisualChange } from "./BaseVisualChange";
import { AdbClient } from "../../utils/android-cmdline-tools/AdbClient";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";

export class HandleIntentChooser extends BaseVisualChange {
  private readonly deepLinkManagerFactory: (
    signal?: AbortSignal,
  ) => Pick<DeepLinkManager, "handleIntentChooser">;

  /**
   * Create an TerminateApp instance
   * @param device - Optional device
   * @param adb - Optional AdbClient instance for testing
   */
  constructor(
    device: BootedDevice,
    adb: AdbClient | null = null,
    deepLinkManagerFactory: (
      signal?: AbortSignal,
    ) => Pick<DeepLinkManager, "handleIntentChooser"> = (signal) =>
      new DeepLinkManager(
        device,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        timer,
        signal,
      ),
    timer: Timer = defaultTimer,
  ) {
    super(device, adb, timer);
    this.device = device;
    this.deepLinkManagerFactory = deepLinkManagerFactory;
  }

  /**
   * Execute intent chooser handling
   * @param preference - User preference for handling ("always", "just_once", or "custom")
   * @param customAppPackage - Optional specific app package to select for custom preference
   * @returns Promise with intent chooser handling results
   */
  async execute(
    preference: "always" | "just_once" | "custom" = "just_once",
    customAppPackage?: string,
    url?: string,
    signal?: AbortSignal,
  ): Promise<IntentChooserResult> {
    throwIfAborted(signal);
    const deepLinkManager = this.deepLinkManagerFactory(signal);
    const perf = createGlobalPerformanceTracker();
    perf.serial("handleIntentChooser");

    return this.observedInteraction(
      async (observeResult: ObserveResult) => {
        const viewHierarchy = observeResult.viewHierarchy;
        if (!viewHierarchy) {
          return { success: false, error: "View hierarchy not found" };
        }

        throwIfAborted(signal);
        return await perf.track("handleChooser", () =>
          deepLinkManager.handleIntentChooser(viewHierarchy, preference, customAppPackage, url),
        );
      },
      {
        signal,
        changeExpected: false,
        timeoutMs: 500,
        perf,
      },
    );
  }
}
