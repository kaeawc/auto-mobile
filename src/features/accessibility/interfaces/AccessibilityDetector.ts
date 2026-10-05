import { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FeatureFlagService } from "../../featureFlags/FeatureFlagService";

/**
 * Type representing the detected accessibility service
 */
export type AccessibilityService = "talkback" | "voiceover" | "unknown";

/** A successful settings read; null from resolveState means unavailable. */
export interface AndroidAccessibilityState {
  enabled: boolean;
  service: AccessibilityService;
  ctrlProxyEnabled: boolean | null;
}

export const TALKBACK_STATE_UNKNOWN_WARNING =
  "AutoMobile could not determine TalkBack state after two probes; using the default gesture. TalkBack may be enabled.";

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

  /** Gesture decision: synchronously retry an unavailable probe once, then return null. */
  resolveTalkBackState(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagService,
  ): Promise<boolean | null>;

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
