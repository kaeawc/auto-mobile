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
import { PortManager } from "../../src/utils/PortManager";
import { isUnitTestPath } from "./realDeviceToolSpawnGuard";
import { clearCtrlProxyRegistries } from "./ctrlProxyRegistryCleanup";

const installFake = (): void => {
  if (isUnitTestPath(Bun.main)) {
    PortManager.setPortAvailabilityCheckerForTesting(new FakePortAvailabilityChecker());
  }
};

installFake();
beforeEach(installFake);
afterEach(() => {
  if (isUnitTestPath(Bun.main)) {
    clearCtrlProxyRegistries();
  }
});
