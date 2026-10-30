import { throwIfAborted } from "../../utils/toolUtils";
import type { Timer } from "../../utils/SystemTimer";
import { defaultTimer } from "../../utils/SystemTimer";
import { DeepLinkManager } from "../utility/DeepLinkManager";
import { BootedDevice, IntentChooserResult, ObserveResult } from "../../models";
import { BaseVisualChange, type DisplayFenceDependencies } from "./BaseVisualChange";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { SETTLE_BUDGET_MS } from "./observedInteractionProfiles";

export class HandleIntentChooser extends BaseVisualChange {
  private readonly deepLinkManagerFactory: (
    signal?: AbortSignal,
  ) => Pick<DeepLinkManager, "handleIntentChooser">;

  /**
   * Create an TerminateApp instance
   * @param device - Optional device
   * @param options - Optional AdbExecutor, DeepLinkManager factory, Timer and collaborators for testing
   */
  constructor(
    device: BootedDevice,
    {
      adb = null,
      deepLinkManagerFactory = (signal) =>
        new DeepLinkManager(device, undefined, { timer, chooserSignal: signal }),
      timer = defaultTimer,
      collaborators = {},
    }: {
      adb?: AdbExecutor | null;
      deepLinkManagerFactory?: (
        signal?: AbortSignal,
      ) => Pick<DeepLinkManager, "handleIntentChooser">;
      timer?: Timer;
      collaborators?: DisplayFenceDependencies;
    } = {},
  ) {
    super(device, adb, timer, undefined, collaborators);
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

    return this.observedInteraction<IntentChooserResult>(
      async (observeResult: ObserveResult) => {
        const viewHierarchy = observeResult.viewHierarchy;
        if (!viewHierarchy) {
          return { success: false, detected: false, error: "View hierarchy not found" };
        }

        throwIfAborted(signal);
        return await perf.track("handleChooser", () =>
          deepLinkManager.handleIntentChooser(viewHierarchy, preference, customAppPackage, url),
        );
      },
      {
        signal,
        changeExpected: false,
        timeoutMs: SETTLE_BUDGET_MS.brief,
        perf,
      },
    );
  }
}
