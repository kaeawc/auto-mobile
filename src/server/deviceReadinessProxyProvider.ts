import { AndroidCtrlProxyManager } from "../utils/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import type { BootedDevice } from "../models";
import type { PerformanceTracker } from "../utils/PerformanceTracker";
import type { ProxySetupResult } from "../utils/interfaces/ProxyManager";

/**
 * Narrow driver that {@link ToolExecutionContext}'s
 * `ensureAccessibilityServiceReady` uses to bring a per-session Android device
 * to automation readiness: reset setup state, run accessibility-service setup,
 * then wait for the CtrlProxy connection.
 *
 * It exists as an injectable seam because `createToolExecutionContext`'s
 * device-readiness upgrade (#6227) now runs this real setup for ANY
 * `existingSession` with no recorded readiness — including sessions minted
 * directly via `SessionManager.createSession` / `DevicePool` in integration
 * tests, which bypass the `deviceTools.ts` acquisition recorder. Against those
 * tests' fake device there is no real `adb`/network, so
 * `AndroidCtrlProxyManager.getInstance(device).setup()` and
 * `AndroidCtrlProxyClient.getInstance(device).waitForConnection()` can block on
 * unbounded host I/O well past bun's 5000ms test timeout; a timed-out test skips
 * its `finally` cleanup and leaks process-wide singletons (e.g. `DaemonState`)
 * into every later test in the same `bun test` process.
 *
 * The shared test preload (`test/setup/testPreload.ts`) installs a fast no-op
 * provider here so NO test can hang on this path, regardless of which file
 * creates the session. Scoping the neutralization to THIS readiness driver —
 * rather than globally replacing `AndroidCtrlProxyManager.getInstance` /
 * `AndroidCtrlProxyClient.getInstance` — leaves the dedicated CtrlProxy
 * manager/client suites exercising real behavior.
 */
export interface DeviceReadinessProxyDriver {
  resetSetupState(): void;
  setup(force: boolean, perf: PerformanceTracker): Promise<ProxySetupResult>;
  waitForConnection(): Promise<boolean>;
  /**
   * Whether the CtrlProxy artifact is already installed on the device (#6227).
   * Consulted only when `--skip-ctrl-proxy-download` is enabled, so the
   * session-scoped readiness upgrade can refuse to download a missing artifact
   * exactly as the fresh acquisition path does — see
   * `ToolExecutionContext.ensureAccessibilityServiceReady`.
   */
  isInstalled(): Promise<boolean>;
}

export type DeviceReadinessProxyDriverProvider = (
  device: BootedDevice,
) => DeviceReadinessProxyDriver;

const realProvider: DeviceReadinessProxyDriverProvider = (device) => {
  const manager = AndroidCtrlProxyManager.getInstance(device);
  return {
    resetSetupState: () => manager.resetSetupState(),
    setup: (force, perf) => manager.setup(force, perf),
    waitForConnection: () => AndroidCtrlProxyClient.getInstance(device).waitForConnection(),
    isInstalled: () => manager.isInstalled(),
  };
};

let provider: DeviceReadinessProxyDriverProvider = realProvider;

/** Resolve the readiness driver for a device through the (possibly overridden) provider. */
export function getDeviceReadinessProxyDriver(device: BootedDevice): DeviceReadinessProxyDriver {
  return provider(device);
}

/**
 * Test seam: override the readiness driver provider process-wide. Pass `null`
 * to restore the real provider.
 */
export function setDeviceReadinessProxyDriverProviderForTesting(
  next: DeviceReadinessProxyDriverProvider | null,
): void {
  provider = next ?? realProvider;
}
