import type { BootedDevice } from "../../models";
import type { CtrlProxyClient } from "../../features/observe/interfaces/CtrlProxyClient";
import type { AccessibilityDetector } from "../../utils/interfaces/AccessibilityDetector";
import type { IosVoiceOverDetector } from "../../utils/interfaces/IosVoiceOverDetector";
import type { PlatformClient } from "../../utils/interfaces/PlatformClient";
import type { ProcessExecutor } from "../../utils/ProcessExecutor";
import type {
  AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { accessibilityDetector as defaultAccessibilityDetector } from "../../utils/AccessibilityDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../../utils/IosVoiceOverDetector";
import { DefaultProcessExecutor } from "../../utils/ProcessExecutor";
import { AndroidCtrlProxyClient } from "../../features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../features/observe/ios/IOSCtrlProxyClient";
import { createTapStrategy } from "../../features/action/strategies/createTapStrategy";
import { createSystemConfigurationAdapter } from "../../features/utility/system-configuration/createSystemConfigurationAdapter";
import {
  getSystemTrayDependencies,
} from "../systemTrayHelpers";
import { createNotificationUIDetector } from "../system-tray/createNotificationUIDetector";

/**
 * Optional injection points for {@link createPlatformClient}. All
 * defaults reach for the same singletons the existing sub-factories
 * use today, so callers that don't override anything get behaviour
 * identical to constructing each handle by hand.
 */
export interface CreatePlatformClientOptions {
  adbFactory?: AdbClientFactory;
  accessibilityDetector?: AccessibilityDetector;
  iosVoiceOverDetector?: IosVoiceOverDetector;
  processExecutor?: ProcessExecutor;
  /** Override the CtrlProxy client (e.g. inject a fake during tests). */
  ctrlProxy?: CtrlProxyClient;
}

/**
 * Build a {@link PlatformClient} for `device`. Performs exactly one
 * `device.platform === "ios"` check and delegates the rest to the
 * platform-agnostic sub-factories established in PRs #2251, #2253 and
 * #2257.
 *
 * NOTE: This PR introduces the type + factory only. Call sites in
 * `toolRegistry.ts` and elsewhere are migrated by follow-up PRs.
 */
export function createPlatformClient(
  device: BootedDevice,
  options: CreatePlatformClientOptions = {}
): PlatformClient {
  const adbFactory = options.adbFactory ?? defaultAdbClientFactory;
  const accessibilityDetector =
    options.accessibilityDetector ?? defaultAccessibilityDetector;
  const iosVoiceOverDetector =
    options.iosVoiceOverDetector ?? defaultIosVoiceOverDetector;
  const processExecutor =
    options.processExecutor ?? new DefaultProcessExecutor();

  const ctrlProxy: CtrlProxyClient =
    options.ctrlProxy ??
    (device.platform === "ios"
      ? IOSCtrlProxyClient.getInstance(device)
      : AndroidCtrlProxyClient.getInstance(device, adbFactory));

  const adb = adbFactory.create(device);

  const tapStrategy = createTapStrategy(
    device,
    adb,
    accessibilityDetector,
    iosVoiceOverDetector
  );

  const systemConfiguration = createSystemConfigurationAdapter(
    device,
    adb,
    processExecutor
  );

  // createNotificationUIDetector reads its dependencies lazily through
  // the supplied getter so callers that swap fakes via
  // setSystemTrayDependencies between invocations still see the latest
  // overrides — same shape as systemTrayHelpers.handleSystemTrayLookFor.
  const notificationUI = createNotificationUIDetector(
    device,
    getSystemTrayDependencies
  );

  return {
    device,
    ctrlProxy,
    tapStrategy,
    systemConfiguration,
    notificationUI,
  };
}
