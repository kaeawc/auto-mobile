import type { FeatureFlagService } from "../../features/featureFlags/FeatureFlagService";
import type { IOSCtrlProxy } from "../../features/observe/ios";

/**
 * Interface for iOS VoiceOver detection
 * Detects and caches VoiceOver state on iOS devices via CtrlProxy
 */
export interface IosVoiceOverDetector {
  /**
   * Check if VoiceOver is enabled on the device.
   *
   * Honest result: resolves to `true` only for a confirmed-enabled probe.
   * An indeterminate probe (timeout, error, or an unsuccessful CtrlProxy
   * response) resolves to `false`, same as a confirmed-disabled probe —
   * callers that need to distinguish "confirmed off" from "unknown" and bias
   * toward the VoiceOver-activation path on "unknown" must use
   * {@link isVoiceOverActiveOrUnknown} instead (issue #6267 follow-up).
   *
   * @param deviceId - The device identifier (for caching)
   * @param client - CtrlProxy service for executing the detection command
   * @param featureFlags - Feature flag service for override support (optional)
   * @returns Promise resolving to true only when VoiceOver is confirmed enabled
   */
  isVoiceOverEnabled(
    deviceId: string,
    client: IOSCtrlProxy,
    featureFlags?: FeatureFlagService,
    timeoutMs?: number,
  ): Promise<boolean>;

  /**
   * Fail-safe variant for consumers that must choose between a plain
   * coordinate touch and a VoiceOver activation gesture (tapOn/tapAny only).
   *
   * Resolves to `true` for a confirmed-enabled probe AND for an
   * indeterminate probe (timeout, error, or an unsuccessful CtrlProxy
   * response) — never coalescing "unknown" to "disabled" — so a real
   * VoiceOver-enabled device never receives a focus-only coordinate touch
   * that gets reported as a successful activation. Only a confirmed
   * `enabled: false` response, or the `accessibility-auto-detect` feature
   * flag being off, resolves to `false` (issue #6267).
   *
   * Do NOT use this for state-confirmation consumers (toggle/query) — they
   * must treat "unknown" as NOT-confirmed, which is what
   * {@link isVoiceOverEnabled} provides.
   *
   * @param deviceId - The device identifier (for caching)
   * @param client - CtrlProxy service for executing the detection command
   * @param featureFlags - Feature flag service for override support (optional)
   * @returns Promise resolving to true when VoiceOver is confirmed enabled or the probe is indeterminate
   */
  isVoiceOverActiveOrUnknown(
    deviceId: string,
    client: IOSCtrlProxy,
    featureFlags?: FeatureFlagService,
    timeoutMs?: number,
  ): Promise<boolean>;

  /**
   * Invalidate the cache for a specific device
   * Should be called after programmatically enabling/disabling VoiceOver
   *
   * @param deviceId - The device identifier to invalidate cache for
   */
  invalidateCache(deviceId: string): void;

  /**
   * Clear all cached entries (primarily for testing)
   */
  clearAllCache(): void;
}
