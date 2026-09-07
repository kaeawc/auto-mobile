import { AndroidCtrlProxyManager } from "../../src/utils/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";

/**
 * #6227: `createToolExecutionContext`'s device-readiness upgrade
 * (`ensureReadinessUpgraded` -> `runDeviceReadinessSetup` ->
 * `ensureAccessibilityServiceReady`) now runs for ANY `existingSession` with
 * no recorded readiness, including sessions minted directly via
 * `SessionManager.createSession` / `DevicePool` in integration tests — which
 * bypass the `deviceTools.ts` acquisition recorder that would otherwise have
 * recorded a readiness level.
 *
 * Against these tests' fake Android device there is no real `adb` (or
 * network) backing `AndroidCtrlProxyManager.getInstance(device).setup()`, so
 * that call can block on a real, unbounded host command / download well
 * past bun's default 5000ms test timeout. A timed-out test skips its
 * `finally` cleanup, leaking process-wide singletons (e.g. `DaemonState`)
 * into every later test in the same `bun test` process — a cascade of
 * unrelated failures.
 *
 * Any integration test that drives a real `ToolRegistry`/`SessionManager`
 * path for an android device MUST call this in `beforeEach` (and
 * `.restore()` in `afterEach`) so accessibility-service setup resolves
 * immediately instead of touching real `adb`.
 */
export interface CtrlProxySetupStub {
  /** Restore the original `getInstance` statics. Call in `afterEach`. */
  restore(): void;
  /** Number of times the stubbed `setup()` was invoked. */
  setupCallCount(): number;
}

export function stubCtrlProxySetup(): CtrlProxySetupStub {
  const originalGetInstance = AndroidCtrlProxyManager.getInstance;
  const originalClientGetInstance = AndroidCtrlProxyClient.getInstance;
  let calls = 0;

  AndroidCtrlProxyManager.getInstance = () =>
    ({
      resetSetupState: () => {},
      setup: async () => {
        calls += 1;
        return { success: true, message: "ok" };
      },
    }) as any;
  AndroidCtrlProxyClient.getInstance = (() => ({
    waitForConnection: async () => true,
    close: async () => {},
  })) as any;
  AndroidCtrlProxyClient.resetInstances();

  return {
    restore(): void {
      AndroidCtrlProxyManager.getInstance = originalGetInstance;
      AndroidCtrlProxyClient.getInstance = originalClientGetInstance;
      AndroidCtrlProxyClient.resetInstances();
    },
    setupCallCount: () => calls,
  };
}
