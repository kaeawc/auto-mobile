import type { BootedDevice } from "../../models";
import type { CtrlProxyClient } from "../../features/observe/interfaces/CtrlProxyClient";
import type { AccessibilityDetector } from "../../utils/interfaces/AccessibilityDetector";
import type { IosVoiceOverDetector } from "../../utils/interfaces/IosVoiceOverDetector";
import type { NotificationUIDetector } from "../../utils/interfaces/NotificationUIDetector";
import type { PlatformClient } from "../../utils/interfaces/PlatformClient";
import type { SystemConfigurationAdapter } from "../../utils/interfaces/SystemConfigurationAdapter";
import type { TapStrategy } from "../../utils/interfaces/TapStrategy";
import { FeatureFlagService } from "../../features/featureFlags/FeatureFlagService";
import type { HostCommandExecutor } from "../../utils/HostCommandExecutor";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { accessibilityDetector as defaultAccessibilityDetector } from "../../utils/AccessibilityDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../../utils/IosVoiceOverDetector";
import { DefaultHostCommandExecutor } from "../../utils/HostCommandExecutor";
import { AndroidCtrlProxyClient } from "../../features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../features/observe/ios/IOSCtrlProxyClient";
import { createTapStrategy } from "../../features/action/strategies/createTapStrategy";
import { createSystemConfigurationAdapter } from "../../features/utility/system-configuration/createSystemConfigurationAdapter";
import { getSystemTrayDependencies } from "../systemTrayHelpers";
import { createNotificationUIDetector } from "../system-tray/createNotificationUIDetector";

type CtrlProxyClientFactory = (
  device: BootedDevice,
  adbFactory: AdbClientFactory,
) => CtrlProxyClient;

function resolveCtrlProxy(
  device: BootedDevice,
  adbFactory: AdbClientFactory,
  options: CreatePlatformClientOptions,
): CtrlProxyClient {
  if (options.ctrlProxy) {
    return options.ctrlProxy;
  }
  if (options.ctrlProxyFactory) {
    return options.ctrlProxyFactory(device, adbFactory);
  }
  return device.platform === "ios"
    ? IOSCtrlProxyClient.getInstance(device)
    : AndroidCtrlProxyClient.getInstance(device, adbFactory);
}

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
  processExecutor?: HostCommandExecutor;
  // Per-handle overrides for tests. Pass a fake instead of letting the
  // factory build the default platform-specific implementation.
  ctrlProxy?: CtrlProxyClient;
  ctrlProxyFactory?: CtrlProxyClientFactory;
  tapStrategy?: TapStrategy;
  systemConfiguration?: SystemConfigurationAdapter;
  notificationUI?: NotificationUIDetector;
  featureFlags?: FeatureFlagService;
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
  options: CreatePlatformClientOptions = {},
): PlatformClient {
  const adbFactory = options.adbFactory ?? defaultAdbClientFactory;
  const accessibilityDetector = options.accessibilityDetector ?? defaultAccessibilityDetector;
  const iosVoiceOverDetector = options.iosVoiceOverDetector ?? defaultIosVoiceOverDetector;
  const processExecutor = options.processExecutor ?? new DefaultHostCommandExecutor();

  const ctrlProxy = resolveCtrlProxy(device, adbFactory, options);

  const adb = adbFactory.create(device);

  const featureFlags = options.featureFlags ?? FeatureFlagService.getInstance();

  const tapStrategy =
    options.tapStrategy ??
    createTapStrategy(device, adb, accessibilityDetector, iosVoiceOverDetector, featureFlags);

  const systemConfiguration =
    options.systemConfiguration ?? createSystemConfigurationAdapter(device, adb, processExecutor);

  // createNotificationUIDetector reads its dependencies lazily through
  // the supplied getter so callers that swap fakes via
  // setSystemTrayDependencies between invocations still see the latest
  // overrides — same shape as systemTrayHelpers.handleSystemTrayLookFor.
  const notificationUI =
    options.notificationUI ?? createNotificationUIDetector(device, getSystemTrayDependencies);

  return {
    device,
    ctrlProxy,
    tapStrategy,
    systemConfiguration,
    notificationUI,
  };
}
