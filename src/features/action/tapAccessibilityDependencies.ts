import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { Timer } from "../../utils/SystemTimer";
import type { AccessibilityDetector } from "../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../accessibility/IosVoiceOverDetector";
import { FeatureFlagService } from "../featureFlags/FeatureFlagService";
import { DefaultTalkBackNavigationDriverFactory } from "../talkback/TalkBackNavigationDriver";
import { TalkBackTapStrategy } from "../talkback/TalkBackTapStrategy";
import { createTapStrategy } from "./strategies/createTapStrategy";
import type { TapOnElementDependencies } from "./TapOnElement";

/** Resolve the screen-reader collaborators and platform strategy used by a tap. */
export function resolveTapAccessibilityDependencies(
  options: TapOnElementDependencies,
  context: {
    device: BootedDevice;
    adbFactory: AdbClientFactory;
    adb: AdbExecutor;
    timer: Timer;
    accessibilityDetector: AccessibilityDetector;
  },
) {
  const { device, adbFactory, adb, timer, accessibilityDetector } = context;
  const talkBackDriverFactory =
    options.talkBackDriverFactory ?? new DefaultTalkBackNavigationDriverFactory(adbFactory);
  const talkBackStrategy =
    options.talkBackStrategy ??
    new TalkBackTapStrategy({ timer, driverFactory: talkBackDriverFactory });
  const iosVoiceOverDetector = options.iosVoiceOverDetector ?? defaultIosVoiceOverDetector;
  const featureFlags = options.featureFlags ?? FeatureFlagService.getInstance();
  const strategy =
    options.tapStrategy ??
    createTapStrategy(device, adb, accessibilityDetector, iosVoiceOverDetector, featureFlags);
  return {
    talkBackDriverFactory,
    talkBackStrategy,
    iosVoiceOverDetector,
    featureFlags,
    strategy,
  };
}
