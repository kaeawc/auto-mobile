import type { BootedDevice } from "../../models";
import type { BaseActionResult } from "../../models/BaseActionResult";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import type { DeviceServicePreflight } from "../../utils/deviceServicePreflight";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import type { IosCtrlProxy } from "../observe/ios/IOSCtrlProxyClient";
import { iosCtrlProxyClientFor } from "../observe/ios/iosCtrlProxyClientFor";
import type { ActionCall } from "./ActionCall";
import { BaseVisualChange, type DisplayFenceDependencies } from "./BaseVisualChange";
import { OBSERVED_INTERACTION_PROFILES, SETTLE_BUDGET_MS } from "./observedInteractionProfiles";

/** Upper bound on the runner's Siri activation; the answer UI settles after it returns. */
export const SIRI_REQUEST_TIMEOUT_MS = 10_000;
export const SIRI_PHRASE_MAX_LENGTH = 500;
/** Printable text only: NUL, newlines and other control characters never reach Siri. */
export const SIRI_PHRASE_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

export const SIRI_ANDROID_UNSUPPORTED =
  "siri is iOS only: it drives XCUIDevice.siriService. Android App Actions are not supported yet.";

export interface ActivateSiriResult extends BaseActionResult {
  phrase: string;
  /** True when the platform or the connected runner cannot activate Siri. */
  unsupported?: boolean;
}

export interface ActivateSiriDependencies extends DisplayFenceDependencies {
  iosClientProvider?: (device: BootedDevice) => Pick<IosCtrlProxy, "requestSiri">;
  /** Fails fast with `device_service_disabled` on a lean-profile simulator (#15223). */
  servicePreflight?: DeviceServicePreflight;
}

/**
 * Activates Siri with recognized-speech text through the iOS runner, so an App Shortcut phrase
 * can be invoked and its effect observed (#14109).
 */
export class ActivateSiri extends BaseVisualChange {
  private readonly iosClientProvider: NonNullable<ActivateSiriDependencies["iosClientProvider"]>;
  private readonly servicePreflight: DeviceServicePreflight;

  constructor(
    device: BootedDevice,
    adb: AdbExecutor | null = null,
    timer: Timer = defaultTimer,
    dependencies: ActivateSiriDependencies = {},
  ) {
    super(device, { adb, timer, displayFence: dependencies });
    this.iosClientProvider = dependencies.iosClientProvider ?? iosCtrlProxyClientFor;
    this.servicePreflight = dependencies.servicePreflight ?? { assertEnabled: async () => {} };
  }

  async execute(phrase: string, call: ActionCall = {}): Promise<ActivateSiriResult> {
    const { progress, signal } = call;
    throwIfAborted(signal);
    const text = phrase.trim();
    if (this.device.platform !== "ios") {
      return { success: false, unsupported: true, phrase: text, error: SIRI_ANDROID_UNSUPPORTED };
    }
    if (
      text.length === 0 ||
      text.length > SIRI_PHRASE_MAX_LENGTH ||
      !SIRI_PHRASE_PATTERN.test(text)
    ) {
      return {
        success: false,
        phrase: text,
        error: `siri phrase must be 1 to ${SIRI_PHRASE_MAX_LENGTH} printable characters (no control characters).`,
      };
    }
    await this.servicePreflight.assertEnabled(this.device, "siri", signal);
    const perf = createGlobalPerformanceTracker();
    perf.serial("siri");
    let unsupported = false;
    const result = await this.observedInteraction(
      async (): Promise<ActivateSiriResult> => {
        const client = this.iosClientProvider(this.device);
        try {
          const response = await perf.track("siriActivation", () =>
            awaitWhileRequestIsLive(
              client.requestSiri(text, SIRI_REQUEST_TIMEOUT_MS, signal),
              signal,
            ),
          );
          if (response.success) {
            return { success: true, phrase: text };
          }
          unsupported = response.unsupported === true;
          return {
            success: false,
            phrase: text,
            error: unsupported
              ? "The connected iOS runner does not support Siri; update the AutoMobile runner."
              : `Siri activation failed: ${response.error ?? "unknown error"}`,
          };
        } catch (error) {
          throwIfAborted(signal);
          logger.warn(`[siri] runner request failed: ${errorMessage(error)}`, error);
          return {
            success: false,
            phrase: text,
            error: `Siri activation failed: ${errorMessage(error)}`,
          };
        }
      },
      {
        // Siri's own overlay may not reach the app hierarchy, and an unresolved phrase changes
        // nothing in the app, so no change is promised; the caller reads the observation.
        ...OBSERVED_INTERACTION_PROFILES.noTreeResolution,
        foregroundAppMayChange: true,
        // A resolved shortcut can launch its app, like a URL dispatch.
        timeoutMs: SETTLE_BUDGET_MS.urlDispatch,
        progress,
        signal,
        perf,
      },
    );
    return unsupported ? { ...result, unsupported: true } : result;
  }
}
