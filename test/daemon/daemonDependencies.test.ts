import { describe, expect, test } from "bun:test";
import { resolveDaemonDependencies } from "../../src/daemon/daemonDependencies";
import { FakeTimer } from "../fakes/FakeTimer";
import { DeviceReadiness } from "../../src/daemon/readiness/DeviceReadiness";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

describe("resolveDaemonDependencies", () => {
  test("shares the injected readiness service with the iOS verifier, with no process singleton", () => {
    const readiness = DeviceReadiness.createInstance(
      new FakeDeviceClientProvider(new FakeAdbExecutor(), new FakeDeviceUtils()),
    );
    const resolved = resolveDaemonDependencies({
      deviceReadiness: readiness,
      timer: new FakeTimer(),
    });
    expect(resolved.deviceReadiness).toBe(readiness);
    expect(resolved.iosDeviceVerifier()).toBe(readiness);
    expect(resolveDaemonDependencies({ timer: new FakeTimer() }).deviceReadiness).not.toBe(
      readiness,
    );
  });
  test("keeps injected collaborators and leaves the optional ones unset", () => {
    const timer = new FakeTimer();
    const processBirthTime = () => 42;
    const resolved = resolveDaemonDependencies({ timer, processBirthTime });

    expect(resolved.timer).toBe(timer);
    expect(resolved.processBirthTime()).toBe(42);
    expect(resolved.installedAppsRepository).toBeUndefined();
    expect(resolved.recoverFromDatabaseHealthFailure).toBeUndefined();
    expect(resolved.foreignCtrlProxyForwardEvidence).toBeUndefined();
  });

  test("defaults every other collaborator", () => {
    const resolved = resolveDaemonDependencies({ timer: new FakeTimer() });

    expect(resolved.recoveryPolicyEnvironment).toBe(process.env);
    expect(typeof resolved.httpServerFactory).toBe("function");
    expect(typeof resolved.bindingExclusionFactory).toBe("function");
    expect(resolved.idGenerator).toBeDefined();
    expect(resolved.deviceSessionRepository).toBeDefined();
  });
});
