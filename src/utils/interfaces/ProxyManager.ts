import type { PerformanceTracker } from "../PerformanceTracker";

/**
 * Coarse classification of a `setup()` failure, set by the manager that
 * caught the underlying error (e.g. `AndroidCtrlProxyManager.setup`'s catch
 * block already sorts failures into these buckets to build its `message`).
 *
 * Issue #7541: retry-decision code (`ToolExecutionContext`'s
 * `ensureAccessibilityServiceReady`) classifies on this typed field instead
 * of substring-matching `message`/`error` a second time downstream, which
 * only ever covered a few unanchored phrases (#6516). `deviceConnection` and
 * `timeout` are transient and worth a bounded retry; `permission`, `install`,
 * `unsupported`, and `networkDownload` are treated as terminal by callers
 * because a retry with no different inputs would fail the same way.
 * `unknown` covers anything the catch block couldn't classify and is treated
 * as terminal (fail fast) rather than guessed at with more string patterns.
 */
export type ProxySetupErrorCategory =
  | "permission"
  | "deviceConnection"
  | "timeout"
  | "networkDownload"
  | "unsupported"
  | "install"
  | "unknown";

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
  /**
   * Set on failure by the catching manager (see {@link ProxySetupErrorCategory}).
   * Optional so managers/test doubles that never set it default to being
   * treated as a terminal (non-retryable) failure.
   */
  category?: ProxySetupErrorCategory;
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
