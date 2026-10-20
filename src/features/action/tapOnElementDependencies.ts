import type { BootedDevice } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { Timer } from "../../utils/SystemTimer";
import type { DisplayFenceDependencies } from "./BaseVisualChange";
import type {
  DisplayTransitionReader,
  DisplayTransitionTracker,
} from "../observe/DisplayTransition";
import type { RenderedObservationReader } from "./TargetDisplayAction";
import type { HierarchyCapture } from "../observe/HierarchyCapture";
import type { VisionFallbackConfig, VisionAnalyzer } from "../../vision/index";
import type {
  ScreenshotCapturer,
  SelectionStateTracker,
} from "../navigation/SelectionStateTracker";
import type { AccessibilityDetector } from "../../ctrlProxy/accessibility/interfaces/AccessibilityDetector";
import { accessibilityDetector as defaultAccessibilityDetector } from "../../ctrlProxy/accessibility/AccessibilityDetector";
import type { ElementSelector } from "../../utils/interfaces/ElementSelector";
import { ResolverElementSelector } from "../utility/ResolverElementSelector";
import {
  DefaultTalkBackNavigationDriverFactory,
  type TalkBackNavigationDriverFactory,
} from "../talkback/TalkBackNavigationDriver";
import { TalkBackTapStrategy } from "../talkback/TalkBackTapStrategy";
import type { IosVoiceOverDetector } from "../accessibility/interfaces/IosVoiceOverDetector";
import { iosVoiceOverDetector as defaultIosVoiceOverDetector } from "../accessibility/IosVoiceOverDetector";
import { FeatureFlagService, type FeatureFlagReader } from "../featureFlags/FeatureFlagService";
import type { TapStrategy } from "../../utils/interfaces/TapStrategy";
import type { WaitForCondition } from "../observe/interfaces/WaitForCondition";
import { createTapStrategy } from "./strategies/createTapStrategy";

/** The TalkBack strategy surface TapOnElement calls; fakes implement exactly this. */
export type TapOnTalkBackStrategy = Pick<
  TalkBackTapStrategy,
  | "executeTap"
  | "executeDirectActivation"
  | "executeCoordinateFallback"
  | "executePreciseTap"
  | "executeLongPress"
>;

/**
 * Dependencies for TapOnElement that can be injected for testing.
 */
export interface TapOnElementDependencies extends DisplayFenceDependencies {
  displayTransitions?: DisplayTransitionReader &
    Pick<DisplayTransitionTracker, "checkIdentity" | "record">;
  lastRenderedObservation?: RenderedObservationReader;
  hierarchyCapture?: HierarchyCapture;
  visionConfig?: VisionFallbackConfig;
  screenshotCapturer?: ScreenshotCapturer;
  visionAnalyzer?: VisionAnalyzer;
  selectionStateTracker?: Pick<SelectionStateTracker, "prepare" | "finalize">;
  accessibilityDetector?: AccessibilityDetector;
  timer?: Timer;
  elementSelector?: ElementSelector;
  talkBackStrategy?: TapOnTalkBackStrategy;
  talkBackDriverFactory?: TalkBackNavigationDriverFactory;
  iosVoiceOverDetector?: IosVoiceOverDetector;
  featureFlags?: FeatureFlagReader;
  waitForCondition?: WaitForCondition;
  /**
   * Override the platform-specific {@link TapStrategy}. Tests use this
   * to inject a fake; production code leaves it unset so the constructor
   * picks the right strategy based on `device.platform`.
   */
  tapStrategy?: TapStrategy;
}

/** Resolve the injectable accessibility dependencies once per tool instance. */
export function createTapAccessibilityDependencies({
  device,
  options,
  adbFactory,
  adb,
  timer,
}: {
  device: BootedDevice;
  options: TapOnElementDependencies;
  adbFactory: AdbClientFactory;
  adb: AdbExecutor;
  timer: Timer;
}) {
  const accessibilityDetector = options.accessibilityDetector || defaultAccessibilityDetector;
  const elementSelector =
    options.elementSelector ??
    new ResolverElementSelector(undefined, undefined, {
      platform: device.platform,
      iosMultiPanel: device.platform === "ios" && (device.displays?.panels.length ?? 0) > 1,
    });
  const talkBackDriverFactory =
    options.talkBackDriverFactory ?? new DefaultTalkBackNavigationDriverFactory(adbFactory);
  const talkBackStrategy =
    options.talkBackStrategy ??
    new TalkBackTapStrategy({
      timer: timer,
      driverFactory: talkBackDriverFactory,
    });
  const iosVoiceOverDetector = options.iosVoiceOverDetector ?? defaultIosVoiceOverDetector;
  const featureFlags = options.featureFlags ?? FeatureFlagService.getInstance();
  const strategy =
    options.tapStrategy ??
    createTapStrategy(device, adb, accessibilityDetector, iosVoiceOverDetector, featureFlags);

  return {
    accessibilityDetector,
    elementSelector,
    talkBackDriverFactory,
    talkBackStrategy,
    iosVoiceOverDetector,
    featureFlags,
    strategy,
  };
}
