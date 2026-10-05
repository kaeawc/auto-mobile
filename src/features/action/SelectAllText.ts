import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { unsupportedPlatformError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BaseVisualChange, ProgressCallback } from "./BaseVisualChange";
import { BootedDevice, SelectAllTextResult } from "../../models";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { AndroidCtrlProxyClient } from "../observe/android";
import { IOSCtrlProxyClient } from "../observe/ios";
import { logger } from "../../utils/logger";

type SelectAllTextCtrlProxy = {
  requestSelectAll(): Promise<{ success: boolean; error?: string; totalTimeMs: number }>;
};
type SelectAllTextCtrlProxyFactory = (
  device: BootedDevice,
  adbFactory: AdbClientFactory,
) => SelectAllTextCtrlProxy;

export class SelectAllText extends BaseVisualChange {
  private readonly ctrlProxyFactory: SelectAllTextCtrlProxyFactory | undefined;

  constructor(
    device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = null,
    ctrlProxyFactory?: SelectAllTextCtrlProxyFactory,
  ) {
    super(device, adbFactoryOrExecutor);
    this.ctrlProxyFactory = ctrlProxyFactory;
  }

  async execute(progress?: ProgressCallback, signal?: AbortSignal): Promise<SelectAllTextResult> {
    throwIfAborted(signal);
    const perf = createGlobalPerformanceTracker();
    perf.serial("selectAllText");

    return this.observedInteraction(
      async () => {
        throwIfAborted(signal);
        try {
          // Platform-specific select all execution
          switch (this.device.platform) {
            case "android":
              return await perf.track("androidSelectAll", () =>
                this.executeAndroidSelectAll(signal),
              );
            case "ios":
              return await perf.track("iOSSelectAll", () => this.executeiOSSelectAll(signal));
            default:
              perf.end();
              throw unsupportedPlatformError(this.device.platform, "select all text");
          }
        } catch (error) {
          throwIfAborted(signal);
          perf.end();
          logger.warn(`Failed to select all text: ${errorMessage(error)}`, error);
          return {
            success: false,
            error: `Failed to select all text: ${errorMessage(error)}`,
          };
        }
      },
      {
        usesObservationForResolution: false,
        changeExpected: false,
        tolerancePercent: 0,
        timeoutMs: 500,
        progress,
        signal,
        perf,
        skipUiStability: true, // Skip UI stability wait - a11y service is fast
      },
    );
  }

  /**
   * Execute iOS-specific select all using CtrlProxy iOS.
   */
  private async executeiOSSelectAll(signal?: AbortSignal): Promise<SelectAllTextResult> {
    try {
      throwIfAborted(signal);
      const client =
        this.ctrlProxyFactory?.(this.device, this.adbFactory) ??
        IOSCtrlProxyClient.getInstance(this.device);
      const result = await awaitWhileRequestIsLive(client.requestSelectAll(), signal);

      if (result.success) {
        logger.info(`[SelectAllText] Select all via CtrlProxy iOS`);
        return { success: true };
      }

      logger.warn(`[SelectAllText] CtrlProxy iOS selectAll failed: ${result.error}`);
      return { success: false, error: result.error };
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[SelectAllText] CtrlProxy iOS exception: ${errorMessage(error)}`);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Execute Android-specific select all using accessibility service.
   * Uses ACTION_SET_SELECTION which is significantly faster than ADB double-tap.
   */
  private async executeAndroidSelectAll(signal?: AbortSignal): Promise<SelectAllTextResult> {
    throwIfAborted(signal);
    const a11yClient =
      this.ctrlProxyFactory?.(this.device, this.adbFactory) ??
      AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
    const a11yResult = await awaitWhileRequestIsLive(a11yClient.requestSelectAll(), signal);

    if (a11yResult.success) {
      logger.info(
        `[SelectAllText] Select all via accessibility service: ${a11yResult.totalTimeMs}ms`,
      );
      return {
        success: true,
      };
    }

    // Return failure
    logger.warn(`[SelectAllText] Accessibility service selectAll failed: ${a11yResult.error}`);
    return {
      success: false,
      error: `Accessibility service selectAll failed: ${a11yResult.error}`,
    };
  }
}
