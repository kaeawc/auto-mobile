import { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FeatureFlagService } from "../../featureFlags/FeatureFlagService";

/**
 * Type representing the detected accessibility service
 */
export type AccessibilityService = "talkback" | "voiceover" | "unknown";

/** Settings evidence, possibly retained after failure; null means unavailable. */
export interface AndroidAccessibilityState {
  /** True only for last-known evidence returned after a failed probe. */
  unconfirmed?: boolean;
  enabled: boolean;
  service: AccessibilityService;
  ctrlProxyEnabled: boolean | null;
}

export interface TalkBackStateConfirmation {
  talkBack: boolean | null;
  unconfirmed: boolean;
}

export const TALKBACK_STATE_UNKNOWN_WARNING =
  "AutoMobile could not determine the current TalkBack state; using the last known state when available, otherwise the default gesture. TalkBack may have changed.";

/**
 * Interface for Android accessibility detection
 * Detects and caches TalkBack state on Android devices via ADB
 */
export interface AccessibilityDetector {
  resolveState(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagService,
  ): Promise<AndroidAccessibilityState | null>;

  /** Gesture decision: retry unavailable evidence once, respecting probe backoff. */
  resolveTalkBackState(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagService,
  ): Promise<boolean | null>;

  /** Optional for compatibility with existing injected detectors. */
  resolveTalkBackStateWithConfirmation?(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagService,
  ): Promise<TalkBackStateConfirmation>;

  /**
   * CtrlProxy's actual enabled state; null means detection failed or was skipped.
   * Omit adb to consume only an existing cached read (e.g. after an observe audit).
   */
  isCtrlProxyServiceEnabled(
    deviceId: string,
    adb?: AdbExecutor,
    featureFlags?: FeatureFlagService,
  ): Promise<boolean | null>;

  /**
   * Check if accessibility services are enabled on the device
   *
   * @param deviceId - The device identifier (for caching)
   * @param adb - ADB executor for executing shell commands
   * @param featureFlags - Feature flag service for override support (optional)
   * @returns Promise resolving to true if accessibility is enabled
   */
  isAccessibilityEnabled(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagService,
  ): Promise<boolean>;

  /**
   * Get the detected accessibility service type
   *
   * @param deviceId - The device identifier (for caching)
   * @param adb - ADB executor for executing shell commands
   * @param featureFlags - Feature flag service for override support (optional)
   * @returns Promise resolving to the detected service type
   */
  detectMethod(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagService,
  ): Promise<AccessibilityService>;

  /**
   * Invalidate the cache for a specific device
   * Should be called after programmatically enabling/disabling TalkBack
   *
   * @param deviceId - The device identifier to invalidate cache for
   */
  invalidateCache(deviceId: string): void;

  /**
   * Clear all cached entries (primarily for testing)
   */
  clearAllCache(): void;
}

/** Preserve legacy injected detectors while carrying confirmation for production taps. */
export async function resolveTalkBackStateConfirmation(
  detector: AccessibilityDetector,
  deviceId: string,
  adb: AdbExecutor,
  featureFlags?: FeatureFlagService,
): Promise<TalkBackStateConfirmation> {
  if (detector.resolveTalkBackStateWithConfirmation) {
    return detector.resolveTalkBackStateWithConfirmation(deviceId, adb, featureFlags);
  }
  const talkBack = await detector.resolveTalkBackState(deviceId, adb, featureFlags);
  return { talkBack, unconfirmed: talkBack === null };
}
