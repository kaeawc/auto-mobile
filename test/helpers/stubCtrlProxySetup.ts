import { setDeviceReadinessProxyDriverProviderForTesting } from "../../src/server/deviceReadinessProxyProvider";

export { setDeviceReadinessProxyDriverProviderForTesting };

/**
 * #6227: `createToolExecutionContext`'s device-readiness upgrade
 * (`ensureReadinessUpgraded` -> `runDeviceReadinessSetup` ->
 * `ensureAccessibilityServiceReady`) runs a real Android accessibility-service
 * setup for ANY `existingSession` with no recorded readiness — including
 * sessions minted directly via `SessionManager.createSession` / `DevicePool` in
 * integration tests, which bypass the `deviceTools.ts` acquisition recorder.
 *
 * The shared test preload (`test/setup/testPreload.ts`) already installs a fast
 * no-op readiness driver process-wide, so no integration test needs to stub this
 * path itself. This helper remains ONLY for the few tests that must ASSERT the
 * readiness path ran (via {@link CtrlProxySetupStub.setupCallCount}); it swaps in
 * a counting no-op driver and, on `restore()`, re-installs the preload's plain
 * no-op default so later tests in the same process stay neutralized.
 */
export interface CtrlProxySetupStub {
  /** Restore the process-wide no-op readiness driver. Call in `afterEach`. */
  restore(): void;
  /** Number of times the stubbed readiness `setup()` was invoked. */
  setupCallCount(): number;
}

/**
 * Re-install the plain no-op readiness driver used by the shared test preload.
 *
 * Test files that need the REAL readiness path (so their own
 * `AndroidCtrlProxyManager.getInstance` / `AndroidCtrlProxyClient.getInstance`
 * overrides take effect) call
 * `setDeviceReadinessProxyDriverProviderForTesting(null)` in `beforeEach` and
 * this in `afterEach`, so the rest of the `bun test` process stays neutralized.
 */
export function installNoOpReadinessDriver(): void {
  setDeviceReadinessProxyDriverProviderForTesting(() => ({
    resetSetupState: () => {},
    setup: async () => ({ success: true, message: "ok" }),
    waitForConnection: async () => true,
  }));
}

export function stubCtrlProxySetup(): CtrlProxySetupStub {
  let calls = 0;

  setDeviceReadinessProxyDriverProviderForTesting(() => ({
    resetSetupState: () => {},
    setup: async () => {
      calls += 1;
      return { success: true, message: "ok" };
    },
    waitForConnection: async () => true,
  }));

  return {
    restore(): void {
      installNoOpReadinessDriver();
    },
    setupCallCount: () => calls,
  };
}
