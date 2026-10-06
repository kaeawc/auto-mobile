import { toActionableError } from "../models/ActionableError";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import type { ProgressCallback } from "./toolRegistry";
import { ActionableError, BootedDevice } from "../models";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { TalkBackToggle } from "../features/accessibility/TalkBackToggle";
import { VoiceOverToggle } from "../features/accessibility/VoiceOverToggle";
import { FeatureFlagService } from "../features/featureFlags/FeatureFlagService";
import { accessibilityDetector } from "../features/accessibility/AccessibilityDetector";
import { iosVoiceOverDetector } from "../features/accessibility/IosVoiceOverDetector";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../utils/logger";
import { accessibilityStateSchema } from "./toolOutputSchemas";
import { DaemonState } from "../daemon/daemonState";
import type { ScreenReaderToggleOptions } from "../models/AccessibilityResult";
import type { ScreenReaderRestoreSlot } from "../features/accessibility/ScreenReaderRestore";
import { runSessionScreenReaderMutation } from "./sessionScreenReader";

export const accessibilitySchema = addDeviceTargetingToSchema(
  z
    .object({
      talkback: z
        .boolean()
        .optional()
        .describe("Enable (true) or disable (false) TalkBack on the active Android device"),
      voiceover: z
        .boolean()
        .optional()
        .describe(
          "Enable (true) or disable (false) VoiceOver on an iOS device (Simulator via simctl; physical devices are driven through the Settings app)",
        ),
    })
    .strict(),
);

interface AccessibilityArgs {
  talkback?: boolean;
  voiceover?: boolean;
  sessionUuid?: string;
}

/**
 * Run a screen-reader toggle so the state the session found is recorded before it
 * is changed and restored when the session releases its device (#10146). The slot is
 * write-once, so a later toggle in the same session never overwrites it.
 */
async function toggleRecordingPreviousState<
  R extends { supported: boolean; currentState?: boolean },
>(
  device: BootedDevice,
  args: AccessibilityArgs,
  run: (options: ScreenReaderToggleOptions) => Promise<R>,
): Promise<R> {
  const manager =
    args.sessionUuid && DaemonState.getInstance().isInitialized()
      ? DaemonState.getInstance().getSessionManager()
      : undefined;
  const platform = device.platform === "ios" ? "ios" : "android";
  return runSessionScreenReaderMutation(
    manager,
    args.sessionUuid,
    device.deviceId,
    async (slot?: ScreenReaderRestoreSlot) => {
      const alreadyRecorded = slot?.get() !== undefined;
      let recordedPrevious: boolean | undefined;
      const result = await run({
        beforeChange: (previousEnabled) => {
          if (slot && !alreadyRecorded) {
            slot.record({ platform, previousEnabled });
            recordedPrevious = previousEnabled;
          }
        },
      });
      // Nothing changed (unsupported, or the write never landed): there is nothing to restore.
      if (
        recordedPrevious !== undefined &&
        (!result.supported || result.currentState === recordedPrevious)
      ) {
        slot?.clear();
      }
      return result;
    },
  );
}

async function toggleTalkBackAccessibility(
  device: BootedDevice,
  args: AccessibilityArgs,
  requestedEnabled: boolean,
) {
  try {
    const toggle = new TalkBackToggle(device);
    const talkback = await toggleRecordingPreviousState(device, args, (options) =>
      toggle.toggle(requestedEnabled, options),
    );
    if (!talkback.supported) {
      throw new ActionableError(
        talkback.reason ?? "TalkBack toggle is not supported on this device",
      );
    }
    if (talkback.currentState === undefined) {
      throw new ActionableError(
        talkback.reason ?? "could not determine TalkBack state after toggle",
      );
    }
    const enabled = talkback.currentState;
    const service = enabled ? ("talkback" as const) : ("unknown" as const);
    return createStructuredToolResponse({
      enabled,
      service,
      ...(!talkback.applied && talkback.reason !== undefined ? { reason: talkback.reason } : {}),
      ...(talkback.warning !== undefined ? { warning: talkback.warning } : {}),
      ...(talkback.blockingPrompt !== undefined ? { blockingPrompt: talkback.blockingPrompt } : {}),
    });
  } catch (error) {
    throw error instanceof ActionableError
      ? error
      : toActionableError(error, `Failed to toggle accessibility services`);
  }
}

async function handleAndroidAccessibility(device: BootedDevice, args: AccessibilityArgs) {
  if (args.voiceover !== undefined) {
    throw new ActionableError("VoiceOver is not supported on Android devices");
  }
  if (args.talkback !== undefined) {
    return await toggleTalkBackAccessibility(device, args, args.talkback);
  }

  // Detect current TalkBack state on Android
  accessibilityDetector.invalidateCache(device.deviceId);
  const adb = defaultAdbClientFactory.create(device);
  const featureFlags = FeatureFlagService.getInstance();
  const state = await accessibilityDetector.resolveState(device.deviceId, adb, featureFlags);
  if (state === null) {
    return createStructuredToolResponse({
      service: "unknown",
      reason: "could not determine TalkBack state: device accessibility settings read unavailable",
    });
  }
  return createStructuredToolResponse({ enabled: state.enabled, service: state.service });
}

async function handleIosAccessibility(device: BootedDevice, args: AccessibilityArgs) {
  if (args.talkback !== undefined) {
    throw new ActionableError("TalkBack is not supported on iOS devices");
  }
  if (args.voiceover !== undefined) {
    const toggle = new VoiceOverToggle(device);
    const requestedEnabled = args.voiceover;
    const voiceover = await toggleRecordingPreviousState(device, args, (options) =>
      toggle.toggle(requestedEnabled, options),
    );
    if (!voiceover.supported) {
      throw new ActionableError(
        voiceover.reason ?? "VoiceOver toggle is not supported on this device",
      );
    }
    if (!voiceover.applied) {
      // Unconfirmed toggle (e.g. a CtrlProxy outage during confirmation
      // polling) must surface as a failure, never as a normal enabled:false
      // response — otherwise the client can't distinguish "confirmed off"
      // from "we don't actually know" (#6496).
      throw new ActionableError(voiceover.reason ?? "VoiceOver toggle could not be confirmed");
    }
    const enabled = voiceover.currentState ?? false;
    const service = enabled ? ("voiceover" as const) : ("unknown" as const);
    return createStructuredToolResponse({ enabled, service });
  }

  // Detect current VoiceOver state on iOS
  iosVoiceOverDetector.invalidateCache(device.deviceId);
  const client = IOSCtrlProxyClient.getInstance(device);
  const featureFlags = FeatureFlagService.getInstance();
  const enabled = await iosVoiceOverDetector.isVoiceOverEnabled(
    device.deviceId,
    client,
    featureFlags,
  );
  const service = enabled ? ("voiceover" as const) : ("unknown" as const);
  logger.debug(`[accessibility tool] VoiceOver state: enabled=${enabled}`);
  return createStructuredToolResponse({ enabled, service });
}

export function registerAccessibilityTools() {
  const accessibilityHandler = async (
    device: BootedDevice,
    args: AccessibilityArgs,
    _progress?: ProgressCallback,
  ) => {
    if (device.platform === "android") {
      return await handleAndroidAccessibility(device, args);
    }
    if (device.platform === "ios") {
      return await handleIosAccessibility(device, args);
    }
    throw new ActionableError(`Unsupported platform: ${device.platform}`);
  };

  ToolRegistry.registerDeviceAware(
    "accessibility",
    "Check or control accessibility services. On Android: omit talkback to check TalkBack state, or pass talkback: true/false to enable/disable it. On iOS: omit voiceover to check VoiceOver state, or pass voiceover: true/false to enable/disable it (Simulator via simctl, physical devices via the Settings app). After enabling TalkBack, reports a blocking system runtime permission prompt in warning and blockingPrompt when detected; AutoMobile does not dismiss it. Use observe, then tapOn to answer the prompt. Always returns fresh state from the device.",
    accessibilitySchema,
    accessibilityHandler,
    { defaultEnabled: false, outputSchema: accessibilityStateSchema },
  );
}
