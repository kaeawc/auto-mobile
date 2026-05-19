import type { PerformanceTracker } from "../PerformanceTracker";

/**
 * Common setup result shared between Android and iOS proxy managers.
 *
 * Platform-specific result types (e.g. `CtrlProxyIosSetupResult` adding
 * `buildResult`) may extend this shape with additional fields.
 */
export interface ProxySetupResult {
  success: boolean;
  message: string;
  error?: string;
  perfTiming?: ReturnType<PerformanceTracker["getTimings"]>;
}

/**
 * Platform-agnostic interface for proxy/control-service managers.
 *
 * Implemented by both `AndroidCtrlProxyManager` (manages the on-device
 * accessibility service) and `IOSCtrlProxyManager` (manages the iOS
 * XCUITest CtrlProxy runner process). Call sites that only need the
 * shared lifecycle surface should depend on this type rather than the
 * concrete platform-specific manager interface.
 *
 * Methods deliberately limited to the true semantic overlap between
 * platforms — installation check, overall availability, setup, and
 * resettable setup-state — so the interface does not leak Android- or
 * iOS-specific concepts.
 */
export interface ProxyManager {
  /**
   * Whether the proxy/control service is installed on the target device.
   * For Android this checks the accessibility service APK; for iOS it
   * checks the CtrlProxy test bundle/app.
   */
  isInstalled(): Promise<boolean>;

  /**
   * Whether the service is fully available for use (installed AND
   * active — `enabled` on Android, `running` on iOS).
   */
  isAvailable(): Promise<boolean>;

  /**
   * Run the full setup flow (download/install/enable or build/start)
   * idempotently. Returns a result object describing what happened.
   */
  setup(force?: boolean, perf?: PerformanceTracker): Promise<ProxySetupResult>;

  /**
   * Reset internal setup-state caches so the next `setup()` call performs
   * a fresh attempt instead of short-circuiting on prior results.
   */
  resetSetupState(): void;
}
