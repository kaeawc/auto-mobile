import { logger } from "../../utils/logger";
import { FeatureFlagService } from "../featureFlags/FeatureFlagService";
import type {
  AccessibilityDetector as IAccessibilityDetector,
  AccessibilityService,
  AndroidAccessibilityState,
} from "./interfaces/AccessibilityDetector";
import { SystemTimer, type Timer } from "../../utils/SystemTimer";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { TTLCache } from "../../utils/cache/Cache";
import {
  CTRL_PROXY_ACCESSIBILITY_SERVICE_COMPONENT,
  CTRL_PROXY_PACKAGE,
} from "../../ctrlProxy/constants";
import { errorMessage } from "../../utils/describeUnknownError";

const TALKBACK_PACKAGE = "com.google.android.marvin.talkback";
const TALKBACK_SERVICE = "TalkBackService";

function normalizeServiceComponent(component: string): string {
  const [packageName, className] = component.split("/", 2);
  if (!packageName || !className) {
    return component;
  }
  if (className.startsWith(".")) {
    return `${packageName}/${packageName}${className}`;
  }
  if (!className.includes(".")) {
    return `${packageName}/${packageName}.${className}`;
  }
  return component;
}

function isCtrlProxyService(component: string): boolean {
  return (
    component === CTRL_PROXY_ACCESSIBILITY_SERVICE_COMPONENT ||
    component === `${CTRL_PROXY_PACKAGE}/.CtrlProxy`
  );
}

function isTalkBackService(component: string): boolean {
  return (
    normalizeServiceComponent(component) ===
    `${TALKBACK_PACKAGE}/${TALKBACK_PACKAGE}.${TALKBACK_SERVICE}`
  );
}

/**
 * DefaultAccessibilityDetector handles detection of accessibility services (TalkBack)
 * with caching to minimize performance impact.
 *
 * Design: As per docs/design-docs/mcp/talkback-voiceover.md Phase 1
 * - Uses ADB shell command for detection (preferred method)
 * - Caches results with 60-second TTL
 * - Supports feature flag overrides for testing
 * - Accepts Timer dependency for testability
 */
export class DefaultAccessibilityDetector implements IAccessibilityDetector {
  private readonly DEFAULT_TTL_MS = 60000; // 60 seconds as per design doc
  private readonly cache: TTLCache<string, AndroidAccessibilityState>;
  private readonly timer: Timer;
  // On failed refresh, retain a successful read only while its age is <90s:
  // the normal 60s TTL plus at most 30s grace. Never renew either TTL on failure.
  // No negative cache: the next call always probes again. Explicit invalidation
  // discards both caches so toggle confirmation cannot reuse pre-toggle state.
  private readonly lastKnownGood: TTLCache<string, AndroidAccessibilityState>;

  constructor(timer: Timer = new SystemTimer()) {
    this.timer = timer;
    this.cache = new TTLCache(timer, { ttlMs: this.DEFAULT_TTL_MS });
    this.lastKnownGood = new TTLCache(timer, { ttlMs: 90000 });
  }

  /**
   * Check if accessibility services are enabled on the device
   *
   * @param deviceId - The device identifier (for caching)
   * @param adb - ADB executor for executing shell commands
   * @param featureFlags - Feature flag service for override support
   * @returns Promise resolving to true if accessibility is enabled
   */
  async isAccessibilityEnabled(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagService,
  ): Promise<boolean> {
    return (await this.resolveState(deviceId, adb, featureFlags))?.enabled ?? false;
  }

  async detectMethod(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagService,
  ): Promise<AccessibilityService> {
    return (await this.resolveState(deviceId, adb, featureFlags))?.service ?? "unknown";
  }

  async resolveState(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagService,
  ): Promise<AndroidAccessibilityState | null> {
    if (featureFlags?.isEnabled("force-accessibility-mode")) {
      return { enabled: true, service: "talkback", ctrlProxyEnabled: null };
    }
    if (featureFlags && !featureFlags.isEnabled("accessibility-auto-detect")) {
      return { enabled: false, service: "unknown", ctrlProxyEnabled: null };
    }
    return this.readState(deviceId, adb);
  }

  async resolveTalkBackState(
    deviceId: string,
    adb: AdbExecutor,
    featureFlags?: FeatureFlagService,
  ): Promise<boolean | null> {
    const state =
      (await this.resolveState(deviceId, adb, featureFlags)) ??
      (await this.resolveState(deviceId, adb, featureFlags));
    return state === null ? null : state.service === "talkback";
  }

  private async readState(
    deviceId: string,
    adb: AdbExecutor,
  ): Promise<AndroidAccessibilityState | null> {
    const cached = this.cache.get(deviceId);
    if (cached) {
      return cached;
    }
    const startTime = this.timer.now();
    const state = await this.detectAccessibilityState(deviceId, adb);
    const detectionTime = this.timer.now() - startTime;
    if (detectionTime > 50) {
      logger.warn(
        `[AccessibilityDetector] Detection took ${detectionTime}ms (target: <50ms) for device ${deviceId}`,
      );
    }
    if (state !== null) {
      this.cache.set(deviceId, state);
      this.lastKnownGood.set(deviceId, state);
      return state;
    }
    return this.lastKnownGood.get(deviceId) ?? null;
  }

  async isCtrlProxyServiceEnabled(
    deviceId: string,
    adb?: AdbExecutor,
    featureFlags?: FeatureFlagService,
  ): Promise<boolean | null> {
    // User-facing force mode is not evidence of CtrlProxy health.
    if (featureFlags && !featureFlags.isEnabled("accessibility-auto-detect")) {
      return null;
    }
    const state = adb ? await this.readState(deviceId, adb) : this.cache.get(deviceId);
    return state?.ctrlProxyEnabled ?? null;
  }

  /**
   * Invalidate the cache for a specific device
   * Should be called after programmatically enabling/disabling TalkBack
   *
   * @param deviceId - The device identifier to invalidate cache for
   */
  invalidateCache(deviceId: string): void {
    logger.debug(`[AccessibilityDetector] Invalidating cache for device ${deviceId}`);
    this.cache.delete(deviceId);
    this.lastKnownGood.delete(deviceId);
  }

  /**
   * Clear all cached entries (primarily for testing)
   */
  clearAllCache(): void {
    logger.debug(`[AccessibilityDetector] Clearing all cached entries`);
    this.cache.clear();
    this.lastKnownGood.clear();
  }

  /**
   * Internal method to detect accessibility state using ADB
   * Method 1 from design doc: Query enabled_accessibility_services setting
   *
   * @param deviceId - The device identifier (for logging)
   * @param adb - ADB executor for executing shell commands
   * @returns Promise resolving to accessibility state
   */
  private async detectAccessibilityState(
    deviceId: string,
    adb: AdbExecutor,
  ): Promise<AndroidAccessibilityState | null> {
    try {
      // Query enabled accessibility services
      const result = await adb.executeCommand(
        "shell settings get secure enabled_accessibility_services",
      );
      if (result.error) {
        throw new Error(result.error);
      }

      const output = result.stdout.trim();

      const services =
        output === "" || output === "null"
          ? []
          : output
              .split(":")
              .map((service) => service.trim())
              .filter(Boolean);
      const nonCtrlProxyServices = services.filter((service) => !isCtrlProxyService(service));
      const ctrlProxyEnabled = services.some(isCtrlProxyService);

      if (nonCtrlProxyServices.some(isTalkBackService)) {
        logger.debug(`[AccessibilityDetector] TalkBack detected as enabled on device ${deviceId}`);
        return { enabled: true, service: "talkback", ctrlProxyEnabled };
      }

      // Check if any accessibility service is enabled (but not TalkBack specifically).
      // `settings get` returns the literal string "null" when the setting is unset;
      // otherwise a colon-separated list of component names. Key off that exact
      // sentinel — a substring scan (`!output.includes("null")`) misclassified any
      // legitimately-enabled service whose component string merely contains "null"
      // as disabled (#3922).
      const isAnyServiceEnabled = nonCtrlProxyServices.length > 0;

      if (isAnyServiceEnabled) {
        logger.debug(
          `[AccessibilityDetector] Unknown accessibility service detected on device ${deviceId}: ${nonCtrlProxyServices.join(":")}`,
        );
        return { enabled: true, service: "unknown", ctrlProxyEnabled };
      }

      logger.debug(
        `[AccessibilityDetector] No accessibility services enabled on device ${deviceId}`,
      );
      return { enabled: false, service: "unknown", ctrlProxyEnabled };
    } catch (error) {
      logger.warn(
        `[AccessibilityDetector] Failed to detect accessibility state for device ${deviceId}: ${errorMessage(error)}`,
        error,
      );
      return null;
    }
  }
}

/**
 * Singleton instance for accessibility detection
 */
export const accessibilityDetector = new DefaultAccessibilityDetector();
