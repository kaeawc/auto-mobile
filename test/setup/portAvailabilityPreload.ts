/**
 * Keep the Android PortManager's host-port probe out of unit tests. This is a
 * separate preload from testPreload.ts so that file stays scoped to its existing
 * test setup. AndroidCtrlProxyClient allocates in its constructor, before the
 * readiness-driver fake can prevent socket access.
 *
 * Read Bun.main at each hook, since argv stays fixed to one selected file in a
 * shared process. Only the currently running unit file receives the fake. Isolated integration files, including the iOS real-socket checker
 * tests, retain real socket behavior. PortManager.test.ts can replace the fake
 * in its own beforeEach, and its direct BunPortAvailabilityChecker tests still
 * exercise the real class through an injected fake BunRuntime. Reinstalling the
 * default before every unit test also covers files whose afterEach restores the
 * real checker with setPortAvailabilityCheckerForTesting(null).
 */
import { afterEach, beforeEach } from "bun:test";
import { FakePortAvailabilityChecker } from "../fakes/FakePortAvailabilityChecker";
import { setCtrlProxyHostPortProbeForTesting } from "../../src/features/observe/android/ctrlProxyHostPortProbe";
import { PortManager } from "../../src/utils/PortManager";
import { isUnitTestPath } from "./realDeviceToolSpawnGuard";
import { clearCtrlProxyRegistries } from "./ctrlProxyRegistryCleanup";
import { screenshotPathProtection } from "../../src/features/observe/ScreenshotPathProtection";

// Unit action/observer constructors enqueue fire-and-forget cache sweeps even
// when capture is faked. Those serialized host-filesystem scans outlive their
// donor tests and can block a later capture until its test times out without
// reaching getInstance restoration in finally. Keep the default sweep inert;
// explicit BoundedScreenshotPathProtection instances still exercise retention.
const sweep = screenshotPathProtection.sweep.bind(screenshotPathProtection);
screenshotPathProtection.sweep = (directory, fileSystem) =>
  isUnitTestPath(Bun.main) ? Promise.resolve() : sweep(directory, fileSystem);

const installFake = (): void => {
  if (isUnitTestPath(Bun.main)) {
    PortManager.setPortAvailabilityCheckerForTesting(new FakePortAvailabilityChecker());
    // The pre-forward bind probe must not touch real sockets either (#10795).
    setCtrlProxyHostPortProbeForTesting({ isPortFree: async () => true });
  }
};

installFake();
beforeEach(installFake);
afterEach(() => {
  if (isUnitTestPath(Bun.main)) {
    clearCtrlProxyRegistries();
  }
});
