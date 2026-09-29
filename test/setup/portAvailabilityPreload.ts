/**
 * Keep the Android PortManager's host-port probe out of unit tests. This is a
 * separate preload from testPreload.ts so that file stays scoped to its existing
 * test setup. AndroidCtrlProxyClient allocates in its constructor, before the
 * readiness-driver fake can prevent socket access.
 *
 * Bun runs the canonical unit and integration lanes with --isolate, giving each
 * preload invocation the current test file in process.argv[1]. Only unit files
 * receive the fake. Integration files, including the iOS real-socket checker
 * tests, retain real socket behavior. PortManager.test.ts can replace the fake
 * in its own beforeEach, and its direct BunPortAvailabilityChecker tests still
 * exercise the real class through an injected fake BunRuntime. Reinstalling the
 * default before every unit test also covers files whose afterEach restores the
 * real checker with setPortAvailabilityCheckerForTesting(null).
 */
import { beforeEach } from "bun:test";
import { FakePortAvailabilityChecker } from "../fakes/FakePortAvailabilityChecker";
import { PortManager } from "../../src/utils/PortManager";

const testFile = (process.argv[1] ?? "").replaceAll("\\", "/");
const isUnitTest =
  testFile.endsWith(".test.ts") &&
  !testFile.endsWith(".integration.test.ts") &&
  !testFile.includes("/test/stress/");

if (isUnitTest) {
  const installFake = (): void => {
    PortManager.setPortAvailabilityCheckerForTesting(new FakePortAvailabilityChecker());
  };

  installFake();
  beforeEach(installFake);
}
