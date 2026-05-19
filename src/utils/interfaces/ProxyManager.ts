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
   * On Android, whether the accessibility service APK is installed;
   * on iOS, whether the CtrlProxy test bundle/app is installed.
   */
  isInstalled(): Promise<boolean>;

  /**
   * Whether the service is fully available: installed AND active
   * (`enabled` on Android, `running` on iOS).
   */
  isAvailable(): Promise<boolean>;

  /** Idempotent — repeat calls short-circuit unless `force` or {@link resetSetupState} intervenes. */
  setup(force?: boolean, perf?: PerformanceTracker): Promise<ProxySetupResult>;

  /** Drop internal setup-state caches so the next {@link setup} call performs a fresh attempt. */
  resetSetupState(): void;
}
