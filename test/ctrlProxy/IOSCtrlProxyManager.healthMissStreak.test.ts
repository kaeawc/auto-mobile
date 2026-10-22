import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import type { BootedDevice } from "../../src/models";
import type { RemoteCtrlProxyIOSRunner } from "../../src/ctrlProxy/ios/IosCtrlProxyContracts";
import { IosCtrlProxyHealthClient } from "../../src/ctrlProxy/ios/IosCtrlProxyHealthClient";
import { IosCtrlProxyProcessClient } from "../../src/ctrlProxy/ios/IosCtrlProxyProcessClient";
import type { HostChildProcess } from "../../src/utils/HostCommandExecutor";
import { createExecResult } from "../../src/utils/execResult";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeLockOwnerGenerationProbe } from "../fakes/FakeLockOwnerGenerationProbe";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  createSupervisorProbe,
  deferred,
  flushUntil,
  installIosManagerSuiteHooks,
} from "../helpers/iosCtrlProxyManagerHarness";

const PROBE_INTERVAL_MS = 30_000;

/** Remote runner that only reports one live PID; any launch or stop is a test failure. */
function liveRemoteRunner(pid: number): RemoteCtrlProxyIOSRunner {
  const unexpectedOperation = () => {
    throw new Error("Reusing a live runner must not launch or stop processes");
  };
  return {
    isEnabled: () => true,
    isRunningInDocker: () => true,
    isAvailable: async () => true,
    getHost: () => "remote-host",
    runIdeviceId: unexpectedOperation,
    runIdeviceInstaller: unexpectedOperation,
    runSimctl: unexpectedOperation,
    startIproxy: unexpectedOperation,
    stopIproxy: unexpectedOperation,
    getIproxyStatus: unexpectedOperation,
    start: unexpectedOperation,
    stop: unexpectedOperation,
    status: async () => ({ success: true, data: { running: true, pid } }),
  };
}

describe("IOSCtrlProxyManager health-miss streak", () => {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  let fakeExecutor: FakeProcessExecutor;

  installIosManagerSuiteHooks((ctx) => {
    testDevice = ctx.testDevice;
    fakeTimer = ctx.fakeTimer;
  });

  beforeEach(() => {
    fakeExecutor = new FakeProcessExecutor();
  });

  const healthy = () =>
    createExecResult(JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }), "");
  const unanswered = () => createExecResult("", "");

  /** A local simulator manager whose health is read through `curl` and liveness through `kill -0`. */
  function localManager() {
    const probe = createSupervisorProbe();
    const manager = IOSCtrlProxyManager.createForTestingWithOptions({
      device: testDevice,
      timer: fakeTimer,
      processExecutor: fakeExecutor,
      processClient: new IosCtrlProxyProcessClient(fakeExecutor, fakeTimer, {
        processGeneration: new FakeLockOwnerGenerationProbe(),
      }),
      processSupervisorFactory: probe.factory,
    });
    return { manager, probe };
  }

  async function expectMissesBeforeRestart(
    supervisor: { isRestartPending(): boolean },
    misses: number,
  ): Promise<void> {
    for (let miss = 1; miss <= misses; miss++) {
      await fakeTimer.advanceTimeAsync(PROBE_INTERVAL_MS);
      expect(supervisor.isRestartPending()).toBe(miss === misses);
    }
  }

  test("a same-PID replacement runner starts with no inherited misses (#14494)", async () => {
    const { manager, probe } = localManager();
    const retired = new FakeChildProcess(fakeTimer);
    manager.trackStartedXcodebuild(retired as HostChildProcess);
    fakeExecutor.setCommandResponse("curl -s", unanswered());
    const supervisor = probe.supervisor;
    try {
      await supervisor.start();
      for (let miss = 1; miss < 3; miss++) {
        await fakeTimer.advanceTimeAsync(PROBE_INTERVAL_MS);
        expect(supervisor.isRestartPending()).toBe(false);
      }
      // Teardown and the relaunch land between probes, so no probe sees the
      // intermediate untracked state, and the OS hands the new runner the same PID.
      supervisor.stop();
      manager.testHooks.trackRunner({ pid: null });
      const replacement = new FakeChildProcess(fakeTimer);
      replacement.pid = retired.pid;
      manager.trackStartedXcodebuild(replacement as HostChildProcess);
      await supervisor.start();

      await expectMissesBeforeRestart(supervisor, 3);
      expect(manager.getXcTestProcessId()).toBe(retired.pid ?? null);
    } finally {
      supervisor.stop();
    }
  });

  test("a health-confirmed start() reuse ends the miss streak (#14493)", async () => {
    const { manager, probe } = localManager();
    manager.testHooks.setState({ xcTestProcessId: 12345 });
    fakeExecutor.setCommandResponse("curl -s", unanswered());
    const supervisor = probe.supervisor;
    try {
      await supervisor.start();
      await fakeTimer.advanceTimeAsync(PROBE_INTERVAL_MS);
      expect(supervisor.isRestartPending()).toBe(false);

      // The local reuse path confirms both PID liveness and a health response.
      fakeExecutor.setCommandResponse("curl -s", healthy());
      await manager.start();
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(0);

      fakeExecutor.setCommandResponse("curl -s", unanswered());
      await expectMissesBeforeRestart(supervisor, 3);
    } finally {
      supervisor.stop();
    }
  });

  describe("a probe that is still awaiting health when start() re-arms supervision (#14492)", () => {
    /**
     * Two completed misses, then a third probe parked on its health answer while
     * start() re-arms supervision on the alive-only remote reuse path. Resolves
     * once the stale probe has answered and been discarded by the supervisor.
     */
    async function armAndDiscardStaleThirdProbe() {
      const probe = createSupervisorProbe();
      const manager = IOSCtrlProxyManager.createForTestingWithOptions({
        device: testDevice,
        timer: fakeTimer,
        processExecutor: fakeExecutor,
        processSupervisorFactory: probe.factory,
        remoteRunner: liveRemoteRunner(12345),
      });
      manager.testHooks.setState({ xcTestProcessId: 12345 });
      let gate: Promise<void> | null = null;
      let parkedProbes = 0;
      const health = spyOn(
        IosCtrlProxyHealthClient.prototype,
        "checkHealthEndpointOnPortForDevice",
      ).mockImplementation(async () => {
        const parked = gate;
        gate = null;
        if (parked) {
          parkedProbes++;
          await parked;
        }
        return false;
      });
      const supervisor = probe.supervisor;
      await manager.start();
      for (let miss = 1; miss < 3; miss++) {
        await fakeTimer.advanceTimeAsync(PROBE_INTERVAL_MS);
        expect(supervisor.isRestartPending()).toBe(false);
      }
      const thirdHealth = deferred();
      gate = thirdHealth.promise;
      await fakeTimer.advanceTimeAsync(PROBE_INTERVAL_MS);
      await flushUntil(() => parkedProbes === 1, "the third probe to await health");

      await manager.start();
      thirdHealth.resolve();
      // Let the parked probe finish its process check and the supervisor discard it.
      for (let turn = 0; turn < 5; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(supervisor.isRestartPending()).toBe(false);
      expect(manager.getXcTestProcessId()).toBe(12345);
      return {
        manager,
        supervisor,
        cleanup: () => {
          health.mockRestore();
          supervisor.stop();
        },
      };
    }

    test("does not retain tracking on a later unrelated runner exit", async () => {
      const { manager, supervisor, cleanup } = await armAndDiscardStaleThirdProbe();
      try {
        supervisor.processExited();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(manager.getXcTestProcessId()).toBeNull();
      } finally {
        cleanup();
      }
    });

    test("keeps the completed misses and does not count the stale one", async () => {
      const { manager, supervisor, cleanup } = await armAndDiscardStaleThirdProbe();
      try {
        await fakeTimer.advanceTimeAsync(PROBE_INTERVAL_MS);
        expect(supervisor.isRestartPending()).toBe(true);
        expect(manager.getXcTestProcessId()).toBe(12345);
      } finally {
        cleanup();
      }
    });
  });
});
