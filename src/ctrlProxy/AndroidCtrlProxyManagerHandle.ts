import type { CtrlProxyManager } from "./CtrlProxyManager";

/**
 * What callers of `AndroidCtrlProxyManager.getInstance` use beyond the platform-neutral
 * {@link CtrlProxyManager} lifecycle: the health, binding-wait and availability-cache hooks.
 * Narrower than the concrete class so `FakeCtrlProxyManager` can stand in for it in tests.
 */
export interface AndroidCtrlProxyManagerHandle extends CtrlProxyManager {
  isAccessibilityServiceHealthy(): Promise<boolean>;
  waitForAccessibilityServiceBinding(): Promise<"already-bound" | "recovered" | "unhealthy">;
  clearAvailabilityCache(): void;
}
