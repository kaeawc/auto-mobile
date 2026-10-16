import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { createExecResult } from "../../src/utils/execResult";
import { IosCtrlProxyProcessClient } from "../../src/ctrlProxy/ios/IosCtrlProxyProcessClient";
import { logger } from "../../src/utils/logger";
import {
  FakeListeningProcess,
  createFakeBuilder,
  deferred,
  installIosManagerSuiteHooks,
  installListeningProcessFakes,
  tunnel,
} from "../helpers/iosCtrlProxyManagerHarness";

describe("IOSCtrlProxyManager restart prevention", function () {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;

  installIosManagerSuiteHooks((ctx) => {
    testDevice = ctx.testDevice;
    fakeTimer = ctx.fakeTimer;
  });

  describe("restart prevention", function () {
    let physicalDevice: BootedDevice;
    let fakeExecutor: FakeProcessExecutor;

    beforeEach(function () {
      physicalDevice = {
        deviceId: "00008030001E28C11E",
        platform: "ios",
        name: "iPhone",
      };
      fakeExecutor = new FakeProcessExecutor();
    });

    test("start() skips spawning when tracked CtrlProxy PID is alive (simulator)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, // simulator UUID
        fakeTimer,
        undefined,
        fakeExecutor,
      );

      // Simulate an already-tracked process (as if startOnSimulator ran previously)
      manager.setXcTestProcessIdForTesting(12345);

      // Health endpoint responds → confirms this PID really is CtrlProxy (not a PID-reused process)
      fakeExecutor.setCommandResponse(
        "curl -s",
        createExecResult(JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }), ""),
      );
      // kill -0 succeeds by default (FakeProcessExecutor never throws) → process alive

      fakeTimer.enableAutoAdvance();
      await manager.start();

      // Process is alive → no simctl spawn or exec for starting the binary
      expect(fakeExecutor.wasCommandExecuted("simctl")).toBe(false);
      expect(fakeExecutor.getSpawnedProcesses().length).toBe(0);
    });

    // Builds a fake ownable runner process modelled on the REAL launch command
    // (see startOnSimulator): xcodebuild with the CtrlProxy UI test target and this
    // device's identity, so isOwnRunnerProcessAlive()'s CtrlProxy-ownership guard
    // treats it as genuinely ours.
    function ownRunnerProcess(pid: number): FakeListeningProcess {
      return {
        pid,
        port: 8765,
        command:
          `xcodebuild test-without-building ` +
          `-xctestrun /tmp/automobile-ctrl-proxy/automobile-runner-${testDevice.deviceId}.xctestrun ` +
          `-destination "platform=iOS Simulator,id=${testDevice.deviceId}" ` +
          `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
      };
    }

    async function withHealthBudget(attempts: string, fn: () => Promise<void>): Promise<void> {
      const prev = process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
      process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = attempts;
      try {
        await fn();
      } finally {
        if (prev === undefined) {
          delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
        } else {
          process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = prev;
        }
      }
    }

    test("stop() tears down only the tracked owned runner tree without global pkill (#2847)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      // Startup may publish its PID while tunnel shutdown yields.
      const internal = manager as unknown as {
        xcTestProcessId: number | null;
        stopIproxyTunnel: () => Promise<void>;
      };
      internal.stopIproxyTunnel = async () => {
        await Promise.resolve();
        internal.xcTestProcessId = 912345;
      };

      const ownedRunner = ownRunnerProcess(912345);
      const otherDeviceRunner: FakeListeningProcess = {
        pid: 912346,
        port: 8766,
        command:
          "xcodebuild test-without-building " +
          "-xctestrun /tmp/automobile-ctrl-proxy/automobile-runner-OTHER.xctestrun " +
          '-destination "platform=iOS Simulator,id=OTHER-SIMULATOR" ' +
          "-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
        environment: "CTRL_PROXY_IOS_PORT=8766 AUTOMOBILE_DEVICE_ID=OTHER-SIMULATOR",
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      const externalHotReloadRunner: FakeListeningProcess = {
        pid: 912347,
        port: 8767,
        command:
          `xcodebuild test-without-building ` +
          `-xctestrun /Users/me/hot-reload/CtrlProxy.xctestrun ` +
          `-destination "platform=iOS Simulator,id=${testDevice.deviceId}" ` +
          `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
        environment: `CTRL_PROXY_IOS_PORT=8767 AUTOMOBILE_EXTERNAL_RUNNER=1 AUTOMOBILE_DEVICE_ID=${testDevice.deviceId}`,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [
        ownedRunner,
        otherDeviceRunner,
        externalHotReloadRunner,
      ]);

      await manager.stop();

      expect(fakeExecutor.wasCommandExecuted("pkill -f 'CtrlProxyUITests-Runner'")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("pkill -f 'xcodebuild.*CtrlProxyUITests'")).toBe(
        false,
      );
      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -912345")).toBe(true);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -912346")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL -- -912346")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -912347")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL -- -912347")).toBe(false);
      expect(ownedRunner.alive).toBe(false);
      expect(otherDeviceRunner.alive).toBe(true);
      expect(externalHotReloadRunner.alive).toBe(true);
    });

    test("stop() does not kill a recycled tracked PID that is no longer our runner (#2847)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(912348);
      const recycledProcess: FakeListeningProcess = {
        pid: 912348,
        port: 8999,
        command: "/usr/sbin/some-unrelated-daemon --serve",
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [recycledProcess]);

      await manager.stop();

      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -912348")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 912348")).toBe(false);
      expect(recycledProcess.alive).toBe(true);
    });

    test("stop() cancels and awaits a local startup before retiring its published runner", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );
      const startupEntered = deferred();
      const releaseStartup = deferred();
      const tunnelStopEntered = deferred();
      const releaseTunnelStop = deferred();
      const runner = new FakeChildProcess(fakeTimer);
      runner.pid = 912349;
      const runnerController = new AbortController();
      const terminatedPids: number[] = [];
      let sharedStartupSignal: AbortSignal | undefined;
      const internal = manager as unknown as {
        sharedStart: { controller: AbortController } | null;
        runnerAbortController: AbortController | null;
        xcTestProcessId: number | null;
        xcTestProcess: FakeChildProcess | null;
        processClient: IosCtrlProxyProcessClient;
        awaitStartupOrphanRunnerReap: () => Promise<void>;
        isCtrlProxyProcessAlive: () => Promise<boolean>;
        isRunning: () => Promise<boolean>;
        startOnDevice: () => Promise<void>;
        waitForHealthEndpoint: (start: { controller: AbortController }) => Promise<boolean>;
        completeHealthStartup: () => Promise<void>;
        stopIproxyTunnel: () => Promise<void>;
        isOwnRunnerProcessAlive: () => Promise<boolean>;
      };
      internal.awaitStartupOrphanRunnerReap = async () => {};
      internal.isCtrlProxyProcessAlive = async () => false;
      internal.isRunning = async () => false;
      internal.startOnDevice = async () => {
        sharedStartupSignal = internal.sharedStart?.controller.signal;
        startupEntered.resolve();
        await releaseStartup.promise;
        internal.runnerAbortController = runnerController;
        internal.xcTestProcessId = runner.pid!;
        internal.xcTestProcess = runner;
      };
      internal.waitForHealthEndpoint = async (start) => {
        start.controller.signal.throwIfAborted();
        return true;
      };
      internal.completeHealthStartup = async () => {};
      internal.stopIproxyTunnel = async () => {
        tunnelStopEntered.resolve();
        await releaseTunnelStop.promise;
      };
      internal.isOwnRunnerProcessAlive = async () => true;
      internal.processClient.terminateProcessTree = async (pid) => {
        terminatedPids.push(pid);
      };

      const startOutcome = manager.start().then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      await startupEntered.promise;

      const stopOutcome = manager.stop().then(
        () => "resolved" as const,
        (error: unknown) => error,
      );
      const startupWasCancelledBeforePublication = sharedStartupSignal?.aborted;
      releaseStartup.resolve();
      await tunnelStopEntered.promise;
      releaseTunnelStop.resolve();
      const [startResult, stopResult] = await Promise.all([startOutcome, stopOutcome]);

      expect(startupWasCancelledBeforePublication).toBe(true);
      expect(startResult).toBeInstanceOf(Error);
      expect(stopResult).toBe("resolved");
      expect(terminatedPids).toEqual([runner.pid]);
      expect(runnerController.signal.aborted).toBe(true);
      expect(internal.xcTestProcessId).toBeNull();
      expect(internal.xcTestProcess).toBeNull();
    });

    test("forceStopForShutdown does not signal a recycled tracked PID that is no longer our runner (#6579)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(912349);
      const foreignProcess: FakeListeningProcess = {
        pid: 912349,
        port: 8998,
        command: "/usr/sbin/some-other-daemons-runner --serve",
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [foreignProcess]);

      // Only relevant if the fix regresses: an unfixed forceStopForShutdown would
      // attempt terminateProcessTree against this never-dying foreign process,
      // whose waitForExit retry loop sleeps via the timer.
      fakeTimer.enableAutoAdvance();
      await manager.forceStopForShutdown(fakeTimer.now() + 5000);

      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -912349")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 912349")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL -- -912349")).toBe(false);
      expect(foreignProcess.alive).toBe(true);
    });

    test("forceStopForShutdown does not signal another daemon runner for the same device", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(912349);
      const foreignProcess: FakeListeningProcess = {
        pid: 912349,
        port: 8998,
        command: ownRunnerProcess(912349).command,
        ppid: process.pid + 1,
        alive: true,
        ignoreTerm: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [foreignProcess]);

      // Only relevant if the fix regresses: an unfixed forceStopForShutdown would
      // attempt terminateProcessTree against this never-dying foreign process,
      // whose waitForExit retry loop sleeps via the timer.
      fakeTimer.enableAutoAdvance();
      await manager.forceStopForShutdown(fakeTimer.now() + 5000);

      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -912349")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 912349")).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -KILL -- -912349")).toBe(false);
      expect(foreignProcess.alive).toBe(true);
    });

    test.each(["error", "timeout"])(
      "keeps an inconclusive ownership %s separate from mismatch",
      async function (mode) {
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          testDevice,
          fakeTimer,
          undefined,
          fakeExecutor,
        );
        fakeExecutor.setCommandHandler("ps -p", async () => {
          if (mode === "error") {
            throw new Error("temporary ps failure");
          }
          return new Promise<ReturnType<typeof createExecResult>>(() => {});
        });
        const result = (
          manager as unknown as {
            isRunnerStillOwnedWithinShutdownDeadline: (pid: number) => Promise<boolean>;
          }
        ).isRunnerStillOwnedWithinShutdownDeadline(912350);
        expect(await fakeTimer.resolvePromise(result)).toBe(true);
        expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
      },
    );
    test("forceStopForShutdown still tree-kills a re-verified owned runner (#6579)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(912350);
      const ownedRunner = { ...ownRunnerProcess(912350), ppid: process.pid };
      installListeningProcessFakes(fakeExecutor, [ownedRunner]);

      await manager.forceStopForShutdown(fakeTimer.now() + 5000);

      // forceStopForShutdown drives terminateProcessTree with skipGraceful, so a
      // re-verified owned runner is signaled straight with SIGKILL (no SIGTERM).
      expect(fakeExecutor.wasCommandExecuted("kill -KILL -- -912350")).toBe(true);
      expect(ownedRunner.alive).toBe(false);
    });

    test("forceStopForShutdown does not SIGKILL an unconfirmed-ownership PID after the probe budget is exhausted (#6898)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      const runnerPid = 912353;
      manager.setXcTestProcessIdForTesting(runnerPid);
      const ownedRunner = { ...ownRunnerProcess(runnerPid), ppid: process.pid };
      installListeningProcessFakes(fakeExecutor, [ownedRunner]);

      const processClient = (manager as unknown as { processClient: IosCtrlProxyProcessClient })
        .processClient;
      let ownershipChecks = 0;
      processClient.checkRunnerOwnership = async (_pid, _deviceId, deadline) => {
        ownershipChecks++;
        if (ownershipChecks === 1) {
          return "owned";
        }
        // Model an exec boundary that consumes exactly the bounded second-probe
        // window before reporting its timeout. SIGKILL must still have its reserve.
        fakeTimer.advanceTime((deadline ?? fakeTimer.now()) - fakeTimer.now());
        throw new Error("runner ownership probe timed out");
      };

      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await manager.forceStopForShutdown(250);

        expect(ownershipChecks).toBe(2);
        expect(fakeTimer.now()).toBeLessThan(250);
        expect(fakeExecutor.wasCommandExecuted(`kill -KILL -- -${runnerPid}`)).toBe(false);
        expect(fakeExecutor.wasCommandExecuted(`kill -TERM -- -${runnerPid}`)).toBe(false);
        expect(ownedRunner.alive).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining(`Forced CtrlProxy runner termination failed`),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("forceStopForShutdown reserves SIGKILL time after both ownership probes confirm the runner (#6898)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      const runnerPid = 912354;
      manager.setXcTestProcessIdForTesting(runnerPid);
      const ownedRunner = { ...ownRunnerProcess(runnerPid), ppid: process.pid };
      installListeningProcessFakes(fakeExecutor, [ownedRunner]);
      const processClient = (manager as unknown as { processClient: IosCtrlProxyProcessClient })
        .processClient;
      let ownershipChecks = 0;
      processClient.checkRunnerOwnership = async (_pid, _deviceId, deadline) => {
        ownershipChecks++;
        if (ownershipChecks === 2) {
          fakeTimer.advanceTime((deadline ?? fakeTimer.now()) - fakeTimer.now());
        }
        return "owned";
      };

      await manager.forceStopForShutdown(250);

      expect(ownershipChecks).toBe(2);
      expect(fakeTimer.now()).toBeLessThan(250);
      expect(fakeExecutor.wasCommandExecuted(`kill -KILL -- -${runnerPid}`)).toBe(true);
      expect(ownedRunner.alive).toBe(false);
    });

    test("forceStopForShutdown skips a foreign PID when an eviction leaves no ownership-check time (#6898)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      const runnerPid = 912356;
      manager.setXcTestProcessIdForTesting(runnerPid);
      const foreignRunner: FakeListeningProcess = {
        pid: runnerPid,
        port: 8765,
        command: "/usr/sbin/some-other-daemons-runner --serve",
        alive: true,
        ignoreKill: true,
      };
      installListeningProcessFakes(fakeExecutor, [foreignRunner]);
      const processClient = (manager as unknown as { processClient: IosCtrlProxyProcessClient })
        .processClient;
      let ownershipChecks = 0;
      processClient.checkRunnerOwnership = async () => {
        ownershipChecks++;
        return "owned";
      };
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await manager.forceStopForShutdown(40);

        expect(ownershipChecks).toBe(0);
        expect(fakeExecutor.wasCommandExecuted(`kill -KILL -- -${runnerPid}`)).toBe(false);
        expect(foreignRunner.alive).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ownership-unverified"));
      } finally {
        warnSpy.mockRestore();
      }
    });

    test("forceStopForShutdown kills a surviving owned process group after its root exits (#6579)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      const runnerPid = 912351;
      manager.setXcTestProcessIdForTesting(runnerPid);
      const exitedRunner = { ...ownRunnerProcess(runnerPid), alive: false };
      const survivingChild: FakeListeningProcess = {
        pid: 912352,
        port: 8765,
        command: "CtrlProxyUITests-Runner",
        alive: true,
        ppid: 1,
        pgid: runnerPid,
      };
      installListeningProcessFakes(fakeExecutor, [exitedRunner, survivingChild]);

      await manager.forceStopForShutdown(250);

      expect(fakeExecutor.wasCommandExecuted(`kill -KILL -- -${runnerPid}`)).toBe(true);
      expect(survivingChild.alive).toBe(false);
    });

    test("start() waits for an own runner then terminates it if it never becomes healthy (#2834)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice, // simulator UUID
        fakeTimer,
        undefined,
        fakeExecutor,
      );

      // A runner we spawned in an earlier setup() whose health endpoint is not up
      // yet (XCUITest still cold-starting on a loaded CI machine). Its PID is alive.
      manager.setXcTestProcessIdForTesting(12345);
      // Health endpoint never responds within this test's tiny budget → the runner
      // is hung, exercising the recovery path below.
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
      const runnerProcs = [ownRunnerProcess(12345)];
      installListeningProcessFakes(fakeExecutor, runnerProcs);

      await withHealthBudget("1", async () => {
        fakeTimer.enableAutoAdvance();
        await expect(manager.start()).rejects.toThrow(/failed to start within timeout/);
      });

      // While it was still starting we did NOT respawn a competing runner (the original
      // livelock was: reclaim the port + respawn mid-startup).
      expect(fakeExecutor.wasCommandExecuted("simctl")).toBe(false);
      expect(fakeExecutor.getSpawnedProcesses().length).toBe(0);
      // Thread-3 recovery: because it never became healthy we TERMINATE the hung runner
      // (rather than leave it alive to be re-adopted by findExternalCtrlProxyProcess on
      // the next start), and clear our tracking so the next start spawns fresh.
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 12345")).toBe(true);
      // The kill targets the process GROUP (tracked PID is the shell wrapper; a
      // single-PID TERM would orphan the xcodebuild child — #2834 review round 5).
      expect(fakeExecutor.wasCommandExecuted("kill -TERM -- -12345")).toBe(true);
      expect(runnerProcs[0].alive).toBe(false);
      expect(manager.getXcTestProcessId()).toBeNull();
      // The auto-restart suppression latch is not left set across the throw (MINOR-2).
      expect((manager as unknown as { isStopping: boolean }).isStopping).toBe(false);
    });

    test("start() re-arms supervision after hung-runner cleanup so the next pre-health exit restarts", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );

      manager.setXcTestProcessIdForTesting(12345);
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
      const runnerProcs = [ownRunnerProcess(12345)];
      installListeningProcessFakes(fakeExecutor, runnerProcs);

      await withHealthBudget("1", async () => {
        fakeTimer.enableAutoAdvance();
        await expect(manager.start()).rejects.toThrow(/failed to start within timeout/);
      });

      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(0);
      expect(manager.getXcTestProcessId()).toBeNull();

      const failedPreHealthProcess = new FakeChildProcess();
      failedPreHealthProcess.pid = 22222;
      manager.setXcTestProcessIdForTesting(failedPreHealthProcess.pid);
      (manager as unknown as { xcTestProcess: FakeChildProcess }).xcTestProcess =
        failedPreHealthProcess;
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        ),
      );

      (manager as unknown as { handleProcessExit: () => void }).handleProcessExit();
      fakeTimer.advanceTime(1000);
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
    });

    test("start() does NOT terminate the tracked PID if it was recycled during the wait (#2834)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(12345);

      // PID 12345 stays alive throughout, and health never answers.
      fakeExecutor.setCommandHandler("kill -0", () => createExecResult("", ""));
      fakeExecutor.setCommandHandler("ps eww", () => createExecResult("some-process", ""));
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
      // `ps -p … -o args=` reports our CtrlProxy runner at the initial wait decision, but
      // a foreign process by the pre-terminate re-verify (the tracked PID was recycled
      // during the long health poll). Registered first so it wins the "ps -p" match.
      let psArgsCalls = 0;
      fakeExecutor.setCommandHandler("ps -p", () => {
        psArgsCalls++;
        const command =
          psArgsCalls <= 1
            ? `1 xcodebuild test-without-building ` +
              `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService ` +
              `-destination "platform=iOS Simulator,id=${testDevice.deviceId}"`
            : "1 /usr/sbin/some-unrelated-daemon --serve";
        return createExecResult(command, "");
      });

      await withHealthBudget("1", async () => {
        fakeTimer.enableAutoAdvance();
        await expect(manager.start()).rejects.toThrow(/failed to start within timeout/);
      });

      // The re-verify sees a foreign command, so the recycled PID is NOT killed — we only
      // un-track it (MINOR-1). isStopping is not left latched (MINOR-2).
      expect(fakeExecutor.wasCommandExecuted("kill -TERM 12345")).toBe(false);
      expect(manager.getXcTestProcessId()).toBeNull();
      expect((manager as unknown as { isStopping: boolean }).isStopping).toBe(false);
      expect(psArgsCalls).toBeGreaterThanOrEqual(2); // wait-decision + pre-kill re-verify
    });

    test("start() reuses an own runner that becomes healthy during the wait (#2834)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(12345);
      const runnerProcs = [ownRunnerProcess(12345)];
      installListeningProcessFakes(fakeExecutor, runnerProcs);

      // Health is down for the initial liveness/running checks (still starting) then
      // comes up once the health poll begins.
      let curlCalls = 0;
      fakeExecutor.setCommandHandler("curl -s", () => {
        curlCalls++;
        return createExecResult(
          curlCalls > 2 ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        );
      });

      await withHealthBudget("30", async () => {
        fakeTimer.enableAutoAdvance();
        await manager.start(); // resolves — runner became healthy, no throw
      });

      // Reused the starting runner: never respawned, never killed, tracking retained.
      expect(fakeExecutor.getSpawnedProcesses().length).toBe(0);
      expect(fakeExecutor.wasCommandExecuted("simctl")).toBe(false);
      expect(runnerProcs[0].alive).toBe(true);
      expect(manager.getXcTestProcessId()).toBe(12345);
    });

    test("start() honors a caller readiness budget beyond the configured health-poll default", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(12345);
      installListeningProcessFakes(fakeExecutor, [ownRunnerProcess(12345)]);

      let curlCalls = 0;
      fakeExecutor.setCommandHandler("curl -s", () => {
        curlCalls++;
        return createExecResult(
          curlCalls > 6 ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        );
      });

      await withHealthBudget("3", async () => {
        fakeTimer.enableAutoAdvance();
        await manager.start({ minimumHealthPollDurationMs: 2_000 });
      });

      expect(curlCalls).toBe(7);
    });

    test("joining readiness caller extends a default startup poll without spawning another runner", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(12345);
      installListeningProcessFakes(fakeExecutor, [ownRunnerProcess(12345)]);

      let curlCalls = 0;
      let releaseFirstHealthPoll: ((result: ExecResult) => void) | undefined;
      const firstHealthPoll = new Promise<ExecResult>((resolve) => {
        releaseFirstHealthPoll = resolve;
      });
      fakeExecutor.setCommandHandler("curl -s", () => {
        curlCalls++;
        if (curlCalls === 3) {
          return firstHealthPoll;
        }
        return createExecResult(
          curlCalls >= 7 ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        );
      });

      await withHealthBudget("3", async () => {
        fakeTimer.enableAutoAdvance();
        const defaultStart = manager.start();
        for (let i = 0; i < 5 && curlCalls < 3; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(curlCalls).toBe(3);

        const readinessStart = manager.start({ minimumHealthPollDurationMs: 2_000 });
        releaseFirstHealthPoll!(createExecResult("", ""));

        await Promise.all([defaultStart, readinessStart]);
      });

      expect(curlCalls).toBe(7);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(0);
    });

    test("an aborted caller does not cancel an independent shared-start waiter", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(12345);
      installListeningProcessFakes(fakeExecutor, [ownRunnerProcess(12345)]);

      let curlCalls = 0;
      fakeExecutor.setCommandHandler("curl -s", () => {
        curlCalls++;
        return createExecResult(
          curlCalls >= 6 ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        );
      });

      await withHealthBudget("3", async () => {
        fakeTimer.enableAutoAdvance();
        const controller = new AbortController();
        const abortedStart = manager.start({ signal: controller.signal });
        const independentStart = manager.start({ minimumHealthPollDurationMs: 2_000 });

        controller.abort(new Error("caller cancelled"));

        await expect(abortedStart).rejects.toThrow("caller cancelled");
        await independentStart;
      });

      expect(curlCalls).toBe(6);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(0);
    });

    test("an aborted caller removes its readiness extension from a shared startup", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(12345);
      installListeningProcessFakes(fakeExecutor, [ownRunnerProcess(12345)]);

      let curlCalls = 0;
      let releaseFirstHealthPoll: ((result: ExecResult) => void) | undefined;
      const firstHealthPoll = new Promise<ExecResult>((resolve) => {
        releaseFirstHealthPoll = resolve;
      });
      fakeExecutor.setCommandHandler("curl -s", () => {
        curlCalls++;
        if (curlCalls === 3) {
          return firstHealthPoll;
        }
        return createExecResult(
          curlCalls >= 5 ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }) : "",
          "",
        );
      });

      await withHealthBudget("1", async () => {
        fakeTimer.enableAutoAdvance();
        const defaultStart = manager.start();
        for (let i = 0; i < 5 && curlCalls < 3; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        expect(curlCalls).toBe(3);

        const controller = new AbortController();
        const extendedStart = manager.start({
          minimumHealthPollDurationMs: 2_000,
          signal: controller.signal,
        });
        controller.abort(new Error("caller cancelled"));
        await expect(extendedStart).rejects.toThrow("caller cancelled");

        releaseFirstHealthPoll!(createExecResult("", ""));
        await expect(defaultStart).rejects.toThrow("CtrlProxy failed to start within timeout");
      });

      expect(curlCalls).toBe(4);
      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(0);
    });

    test("a caller arriving during hung-runner teardown starts fresh after it settles", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(12345);
      installListeningProcessFakes(fakeExecutor, [ownRunnerProcess(12345)]);

      // Healthy only once the fresh runner has been spawned. Keyed on the spawn,
      // not on the test's progress, because auto-advance keeps running the retry's
      // health window while the test awaits the original start's rejection.
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().length > 0
            ? JSON.stringify({ status: "ok", deviceId: testDevice.deviceId })
            : "",
          "",
        ),
      );

      const teardownEntered = deferred();
      const releaseTeardown = deferred();
      const processClient = (
        manager as unknown as {
          processClient: IosCtrlProxyProcessClient;
        }
      ).processClient;
      const terminateProcessTree = processClient.terminateProcessTree.bind(processClient);
      processClient.terminateProcessTree = async (pid) => {
        teardownEntered.resolve();
        await releaseTeardown.promise;
        await terminateProcessTree(pid);
      };

      await withHealthBudget("1", async () => {
        fakeTimer.enableAutoAdvance();
        const originalStart = manager.start();
        await teardownEntered.promise;

        const retryStart = manager.start({ minimumHealthPollDurationMs: 2_000 });
        await new Promise((resolve) => setImmediate(resolve));
        expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(0);

        releaseTeardown.resolve();
        await expect(originalStart).rejects.toThrow("CtrlProxy failed to start within timeout");
        await retryStart;
      });

      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(1);
    });

    test("retires the tracked runner and iproxy when the final health-poll waiter cancels (#6905)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        createFakeBuilder(),
        fakeExecutor,
      );
      const runnerPid = 912354;
      const runner = {
        pid: runnerPid,
        port: 8765,
        command:
          `xcodebuild CtrlProxy -destination id=${physicalDevice.deviceId} ` +
          "-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
        alive: true,
        ppid: process.pid,
      };
      installListeningProcessFakes(fakeExecutor, [runner]);
      const iproxy = new FakeChildProcess(fakeTimer);
      iproxy.pid = 912355;
      const healthPollingEntered = deferred();
      const internal = manager as unknown as {
        xcTestProcessId: number | null;
        xcTestProcess: FakeChildProcess | null;
        awaitStartupOrphanRunnerReap: () => Promise<void>;
        isCtrlProxyProcessAlive: () => Promise<boolean>;
        isRunning: () => Promise<boolean>;
        startOnDevice: () => Promise<void>;
        waitForHealthEndpoint: (start: { controller: AbortController }) => Promise<boolean>;
      };
      internal.awaitStartupOrphanRunnerReap = async () => {};
      internal.isCtrlProxyProcessAlive = async () => false;
      internal.isRunning = async () => false;
      internal.startOnDevice = async () => {
        internal.xcTestProcessId = runnerPid;
        internal.xcTestProcess = new FakeChildProcess(fakeTimer);
        fakeExecutor.setNextSpawnProcess(iproxy);
        tunnel(manager)["iproxyProcessId"] = iproxy.pid!;
        tunnel(manager)["iproxyProcess"] = fakeExecutor.spawn("iproxy", []);
      };
      internal.waitForHealthEndpoint = async (start) => {
        healthPollingEntered.resolve();
        return await new Promise<boolean>((_resolve, reject) => {
          start.controller.signal.addEventListener(
            "abort",
            () => reject(start.controller.signal.reason),
            { once: true },
          );
        });
      };

      const caller = new AbortController();
      const starting = manager.start({ signal: caller.signal });
      await healthPollingEntered.promise;
      caller.abort(new Error("last caller cancelled"));
      await expect(starting).rejects.toThrow("last caller cancelled");
      for (let attempt = 0; attempt < 20 && !iproxy.killed; attempt++) {
        await Promise.resolve();
      }
      fakeTimer.advanceTime(0);

      expect(fakeExecutor.wasCommandExecuted(`kill -KILL -- -${runnerPid}`)).toBe(true);
      expect(runner.alive).toBe(false);
      expect(iproxy.killed).toBe(true);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    });

    test("a retry starts fresh after the prior sole caller aborts", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(12345);
      installListeningProcessFakes(fakeExecutor, [ownRunnerProcess(12345)]);

      let curlCalls = 0;
      let releaseFirstHealthPoll: ((result: ExecResult) => void) | undefined;
      const firstHealthPoll = new Promise<ExecResult>((resolve) => {
        releaseFirstHealthPoll = resolve;
      });
      fakeExecutor.setCommandHandler("curl -s", () => {
        curlCalls++;
        if (curlCalls === 1) {
          return firstHealthPoll;
        }
        return createExecResult(
          JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }),
          "",
        );
      });

      const controller = new AbortController();
      const abortedStart = manager.start({ signal: controller.signal });
      for (let i = 0; i < 5 && curlCalls < 1; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(curlCalls).toBe(1);

      controller.abort(new Error("caller cancelled"));
      await expect(abortedStart).rejects.toThrow("caller cancelled");

      const retry = manager.start();
      await new Promise((resolve) => setImmediate(resolve));
      expect(curlCalls).toBe(1);
      releaseFirstHealthPoll!(createExecResult("", ""));
      await retry;

      expect(fakeExecutor.getSpawnedProcesses()).toHaveLength(0);
    });

    test("retires a cancelled startup while an immediate retry is barrier-waiting", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      const firstStartEntered = deferred();
      let rejectFirstStart!: (error: Error) => void;
      let startInternalCalls = 0;
      spyOn(manager as any, "startInternal").mockImplementation(() => {
        startInternalCalls++;
        if (startInternalCalls === 1) {
          firstStartEntered.resolve();
          return new Promise<void>((_resolve, reject) => {
            rejectFirstStart = reject;
          });
        }
        return Promise.resolve();
      });
      const forceStop = spyOn(manager as any, "forceStopForShutdown").mockResolvedValue();

      const caller = new AbortController();
      const cancelledStart = manager.start({ signal: caller.signal });
      await firstStartEntered.promise;
      caller.abort(new Error("caller cancelled"));
      await expect(cancelledStart).rejects.toThrow("caller cancelled");

      // Keep the first start pending until the retry has joined it as the
      // non-joinable barrier waiter. That waiter is not an external caller.
      const retry = manager.start();
      await Promise.resolve();
      rejectFirstStart(new Error("startup cancelled"));

      await retry;

      expect(forceStop).toHaveBeenCalledTimes(1);
      expect(startInternalCalls).toBe(2);
    });

    test("bounds retirement when a remote runner stop never settles", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      const internal = manager as unknown as {
        xcTestProcessId: number | null;
        remoteRunner: { stop: () => Promise<{ success: boolean }> };
        useRemoteRunner: () => boolean;
        retireRunnerAfterFinalSharedStartCancellation: (sharedStart: {
          controller: AbortController;
          completion: Promise<void>;
          healthPollDeadlineMs: number | null;
          defaultHealthPollDeadlineMs: number | null;
          callerHealthPollDeadlinesMs: Map<symbol, number>;
          teardownCommitted: boolean;
          waitingCallers: number;
          externalWaitingCallers: number;
          completed: boolean;
        }) => Promise<void>;
      };
      internal.xcTestProcessId = 912357;
      spyOn(internal, "useRemoteRunner").mockReturnValue(true);
      internal.remoteRunner.stop = () => new Promise(() => {});
      const sharedStart = {
        controller: new AbortController(),
        completion: Promise.resolve(),
        healthPollDeadlineMs: null,
        defaultHealthPollDeadlineMs: null,
        callerHealthPollDeadlinesMs: new Map<symbol, number>(),
        teardownCommitted: false,
        waitingCallers: 0,
        externalWaitingCallers: 0,
        completed: false,
      };
      sharedStart.controller.abort(new Error("caller cancelled"));

      let retired = false;
      const retirement = internal.retireRunnerAfterFinalSharedStartCancellation(sharedStart);
      void retirement.then(() => {
        retired = true;
      });
      await Promise.resolve();

      fakeTimer.advanceTime(250);
      for (let attempt = 0; attempt < 5 && !retired; attempt++) {
        await Promise.resolve();
      }

      expect(retired).toBe(true);
      await retirement;
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    });

    // Directly exercise the PID-reuse guard added in review (thread 2). Testing the
    // predicate rather than a full start() keeps it precise and avoids spawning a
    // runner (whose background monitor would leak into later tests under autoAdvance).
    const callIsOwnRunnerProcessAlive = (m: IOSCtrlProxyManager): Promise<boolean> =>
      (m as unknown as { isOwnRunnerProcessAlive(): Promise<boolean> }).isOwnRunnerProcessAlive();

    test("isOwnRunnerProcessAlive rejects a reused PID that is not our runner (#2834)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      // The tracked PID is alive but has been reused by an UNRELATED process
      // (not xcodebuild, no device identity).
      manager.setXcTestProcessIdForTesting(12345);
      installListeningProcessFakes(fakeExecutor, [
        {
          pid: 12345,
          port: 9999,
          command: "/usr/sbin/some-unrelated-daemon --serve",
          alive: true,
        },
      ]);

      expect(await callIsOwnRunnerProcessAlive(manager)).toBe(false);
    });

    test("isOwnRunnerProcessAlive rejects a CtrlProxy runner for a DIFFERENT device (#2834)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(12345);
      // A genuine CtrlProxy runner, but for a sibling simulator (different device id).
      installListeningProcessFakes(fakeExecutor, [
        {
          pid: 12345,
          port: 8765,
          command:
            "xcodebuild test-without-building " +
            "-xctestrun /tmp/automobile-ctrl-proxy/automobile-runner-OTHER.xctestrun " +
            '-destination "platform=iOS Simulator,id=OTHER-DEVICE-UUID" ' +
            "-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
          environment: "CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=OTHER-DEVICE-UUID",
          alive: true,
        },
      ]);

      expect(await callIsOwnRunnerProcessAlive(manager)).toBe(false);
    });

    test("isOwnRunnerProcessAlive rejects a user's own xcodebuild on the same simulator (#2834)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(12345);
      // The tracked PID was reused by the user's OWN app test run, which targets the
      // same simulator (xcodebuild + our device id) but is NOT a CtrlProxy runner. It
      // must not be mistaken for our runner — otherwise we would wait on it and later
      // terminate it as "hung", killing the user's process (#2834 review, thread 2).
      installListeningProcessFakes(fakeExecutor, [
        {
          pid: 12345,
          port: 8999,
          command:
            `xcodebuild test -project MyApp.xcodeproj ` +
            `-destination "platform=iOS Simulator,id=${testDevice.deviceId}"`,
          alive: true,
        },
      ]);

      expect(await callIsOwnRunnerProcessAlive(manager)).toBe(false);
    });

    test("isOwnRunnerProcessAlive accepts our live xcodebuild runner for this device (#2834)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(12345);
      installListeningProcessFakes(fakeExecutor, [ownRunnerProcess(12345)]);

      expect(await callIsOwnRunnerProcessAlive(manager)).toBe(true);
    });

    test("isOwnRunnerProcessAlive returns false when the tracked PID is dead (#2834)", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(12345);
      // No living process with this PID (installListeningProcessFakes' kill -0 throws).
      installListeningProcessFakes(fakeExecutor, [
        {
          ...ownRunnerProcess(12345),
          alive: false,
        },
      ]);

      expect(await callIsOwnRunnerProcessAlive(manager)).toBe(false);
    });

    test("health-poll budget is env-configurable with a generous default (#2834)", function () {
      const resolve = (): number =>
        (
          IOSCtrlProxyManager as unknown as { resolveHealthPollMaxAttempts(): number }
        ).resolveHealthPollMaxAttempts();
      const prev = process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
      try {
        process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = "240";
        expect(resolve()).toBe(240);
        // Invalid values fall back to the default (which is well above the old 30 = 15s).
        process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = "nonsense";
        expect(resolve()).toBeGreaterThan(30);
        delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
        expect(resolve()).toBeGreaterThan(30);
      } finally {
        if (prev === undefined) {
          delete process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS;
        } else {
          process.env.AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS = prev;
        }
      }
    });

    test("start() re-establishes iproxy tunnel when CtrlProxy is alive but tunnel is gone (physical device)", async function () {
      fakeExecutor.setCommandResponse(
        "idevice_id -l",
        createExecResult(`${physicalDevice.deviceId}\n`, ""),
      );
      // On a local physical device /health is only reachable through iproxy, so the
      // runner answers only once an iproxy spawn has been recorded. Stubbing a healthy
      // answer with no tunnel modelled a state that cannot exist and hid the second
      // xcodebuild the old code launched here (#10234).
      fakeExecutor.setCommandHandler("curl -s", () =>
        createExecResult(
          fakeExecutor.getSpawnedProcesses().some((spawned) => spawned.command === "iproxy")
            ? JSON.stringify({ status: "ok", deviceId: physicalDevice.deviceId })
            : "",
          "",
        ),
      );
      const fakeProcess = new FakeChildProcess();
      fakeExecutor.setNextSpawnProcess(fakeProcess);
      // The tracked PID is our still-running device runner; the respawned iproxy is alive too.
      installListeningProcessFakes(fakeExecutor, [
        {
          pid: 12345,
          port: 8765,
          command:
            `xcodebuild test-without-building ` +
            `-xctestrun /tmp/automobile-ctrl-proxy/automobile-runner-${physicalDevice.deviceId}.xctestrun ` +
            `-destination id=${physicalDevice.deviceId} ` +
            `-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`,
          environment: `CTRL_PROXY_IOS_PORT=8765 AUTOMOBILE_DEVICE_ID=${physicalDevice.deviceId}`,
          alive: true,
        },
        { pid: fakeProcess.pid!, port: 0, command: "iproxy", alive: true },
      ]);

      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        physicalDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );

      // Simulate: CtrlProxy process is alive but iproxy tunnel was stopped
      manager.setXcTestProcessIdForTesting(12345);
      // iproxyProcessId is null → tunnel is gone

      fakeTimer.enableAutoAdvance();
      await manager.start();

      // iproxy is (re-)spawned for the live runner, and no second xcodebuild is launched
      expect(fakeExecutor.getSpawnedProcesses().length).toBe(1);
      expect(fakeExecutor.getSpawnedProcesses()[0].command).toBe("iproxy");
    });

    test("xctest process supervisor uses the injected timer so tests can control it", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );

      expect(fakeTimer.getPendingIntervals().length).toBe(0);

      await (
        manager as unknown as { processSupervisor: { start: () => Promise<void> } }
      ).processSupervisor.start();

      expect(fakeTimer.getPendingIntervals().length).toBe(1);
      expect(fakeTimer.getPendingIntervals()[0]).toBe(30000);
    });

    test("xctest process supervisor treats a live launcher with a dead health endpoint as unhealthy", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      manager.setXcTestProcessIdForTesting(12345);
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
      fakeExecutor.setCommandResponse("kill -0 12345", createExecResult("", ""));

      const alive = await (
        manager as unknown as { isSupervisedCtrlProxyProcessAlive: () => Promise<boolean> }
      ).isSupervisedCtrlProxyProcessAlive();

      expect(alive).toBe(false);
    });

    test("xctest process supervisor restarts once when health is down and the tracked PID is missing", async function () {
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      const internal = manager as unknown as {
        xcTestProcessId: number | null;
        isSupervisedCtrlProxyProcessAlive: () => Promise<boolean>;
        processSupervisor: { start: () => Promise<void> };
      };
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));

      // Prime the public status cache with the dead runner state. The supervisor's
      // onExit callback must clear it so readiness can observe the replacement.
      expect(await manager.isRunning()).toBe(false);
      expect(await internal.isSupervisedCtrlProxyProcessAlive()).toBe(false);
      expect(fakeExecutor.wasCommandExecuted("kill -0")).toBe(false);

      let restartAttempts = 0;
      spyOn(manager, "start").mockImplementation(async () => {
        restartAttempts++;
        internal.xcTestProcessId = 67890;
        fakeExecutor.setCommandResponse(
          "curl -s",
          createExecResult(JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }), ""),
        );
      });

      await internal.processSupervisor.start();
      fakeTimer.advanceTime(30000);
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(restartAttempts).toBe(0);
      expect(fakeTimer.getPendingTimeouts()).toEqual([2000]);

      fakeTimer.advanceTime(2000);
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(restartAttempts).toBe(1);
      expect(internal.xcTestProcessId).toBe(67890);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
      expect(fakeTimer.getPendingIntervals()).toEqual([30000]);
      expect(await manager.isRunning()).toBe(true);

      fakeTimer.advanceTime(30000);
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(restartAttempts).toBe(1);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    });

    test("a second liveness signal while a restart is already scheduled does not double-schedule (ProcessSupervisor.ts scheduleRestart's restartTimeout guard, ProcessSupervisor.ts:125)", async function () {
      // Reproduces the state the follow-up review asked for: xcTestProcessId is
      // null (as onExit would leave it) AND the health endpoint is dead AND a
      // restart has already been scheduled (backoff timer pending) when a second
      // "runner is dead" signal arrives — e.g. a duplicate/racing liveness poll,
      // or a stray event-driven exit callback. `DefaultProcessSupervisor.scheduleRestart`
      // (src/utils/ProcessSupervisor.ts:124-141) guards on `this.restartTimeout`
      // being already set and returns immediately without incrementing
      // `restartAttempts` or touching the pending timeout, so this is a single,
      // deterministic assertion on that structural guard rather than a new
      // production behavior.
      const manager = IOSCtrlProxyManager.createForTestingWithDeps(
        testDevice,
        fakeTimer,
        undefined,
        fakeExecutor,
      );
      const internal = manager as unknown as {
        xcTestProcessId: number | null;
        isSupervisedCtrlProxyProcessAlive: () => Promise<boolean>;
        processSupervisor: { start: () => Promise<void>; processExited: () => void };
      };
      fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));

      expect(await internal.isSupervisedCtrlProxyProcessAlive()).toBe(false);

      let restartAttempts = 0;
      spyOn(manager, "start").mockImplementation(async () => {
        restartAttempts++;
        internal.xcTestProcessId = 67890;
        fakeExecutor.setCommandResponse(
          "curl -s",
          createExecResult(JSON.stringify({ status: "ok", deviceId: testDevice.deviceId }), ""),
        );
      });

      await internal.processSupervisor.start();

      // First "dead" signal: the 30s monitor tick observes health down + no
      // tracked PID, and schedules a bounded restart.
      fakeTimer.advanceTime(30000);
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(fakeTimer.getPendingTimeouts()).toEqual([2000]);
      expect(restartAttempts).toBe(0);

      // Second "dead" signal arrives while the restart is already in flight
      // (backoff timer pending, xcTestProcessId still null, health still down).
      // This simulates a racing/duplicate liveness detection rather than the
      // 30s interval, since `handleProcessExit` already stopped the monitor
      // interval for this generation.
      internal.processSupervisor.processExited();
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // No second/concurrent restart was scheduled: still exactly one pending
      // timeout, at the original 2000ms delay (not re-scheduled to a fresh
      // attempt), and no restart has fired yet.
      expect(fakeTimer.getPendingTimeoutCount()).toBe(1);
      expect(fakeTimer.getPendingTimeouts()).toEqual([2000]);
      expect(restartAttempts).toBe(0);

      // Let the single scheduled restart fire.
      fakeTimer.advanceTime(2000);
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // Exactly one restart total, despite two "dead" signals.
      expect(restartAttempts).toBe(1);
      expect(fakeTimer.getPendingTimeoutCount()).toBe(0);
    });

    describe("iproxy monitor uses process liveness not health endpoint", function () {
      beforeEach(function () {
        fakeExecutor.setCommandResponse(
          "idevice_id -l",
          createExecResult(`${physicalDevice.deviceId}\n`, ""),
        );
      });

      test("does not restart iproxy when process is alive even if health check fails", async function () {
        const fakeProcess = new FakeChildProcess();
        fakeExecutor.setNextSpawnProcess(fakeProcess);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice,
          fakeTimer,
          undefined,
          fakeExecutor,
        );

        await manager.startIproxyTunnel();
        expect(fakeExecutor.getSpawnedProcesses().length).toBe(1);

        // Health endpoint fails (would have triggered restart in old code)
        fakeExecutor.setCommandResponse("curl -s", createExecResult("", ""));
        // kill -0 succeeds by default → iproxy process alive

        // Fire one monitor interval
        fakeTimer.advanceTime(5000);
        for (let i = 0; i < 5; i++) {
          await Promise.resolve();
        }

        // iproxy is alive → no restart scheduled
        expect(fakeExecutor.getSpawnedProcesses().length).toBe(1);
      });

      test("restarts iproxy when iproxyProcessId is null (process gone)", async function () {
        const fakeProcess1 = new FakeChildProcess();
        const fakeProcess2 = new FakeChildProcess();
        fakeExecutor.setNextSpawnProcess(fakeProcess1);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice,
          fakeTimer,
          undefined,
          fakeExecutor,
        );

        await manager.startIproxyTunnel();

        // Simulate iproxy process dying between monitor ticks (clears tracking state)
        tunnel(manager)["iproxyProcessId"] = null;
        tunnel(manager)["iproxyProcess"] = null;

        fakeExecutor.setNextSpawnProcess(fakeProcess2);

        // Fire monitor — sees no tracked process → schedules restart
        fakeTimer.advanceTime(5000);
        for (let i = 0; i < 5; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }

        // Fire restart timer (first attempt = 1000 ms base delay)
        fakeTimer.advanceTime(1000);
        for (let i = 0; i < 5; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }

        expect(fakeExecutor.getSpawnedProcesses().length).toBe(2);
      });

      test("resumes iproxy monitoring after scheduled restart completes", async function () {
        const fakeProcess1 = new FakeChildProcess();
        const fakeProcess2 = new FakeChildProcess();
        fakeExecutor.setNextSpawnProcess(fakeProcess1);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice,
          fakeTimer,
          undefined,
          fakeExecutor,
        );

        await manager.startIproxyTunnel();

        // Process exit triggers scheduleIproxyRestart
        fakeProcess1.emit("exit", 1, null);
        await Promise.resolve();

        fakeExecutor.setNextSpawnProcess(fakeProcess2);

        // Fire restart timer (1000 ms base delay for first attempt)
        fakeTimer.advanceTime(1000);
        for (let i = 0; i < 5; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }

        // After restart, startIproxyMonitoring() should have been called → new interval pending
        expect(fakeTimer.getPendingIntervals().length).toBe(1);
      });

      test("keeps retrying when a scheduled iproxy restart attempt fails before the tunnel is supervised", async function () {
        const fakeProcess1 = new FakeChildProcess();
        const fakeProcess2 = new FakeChildProcess();
        fakeProcess2.pid = undefined as unknown as number;
        fakeExecutor.setNextSpawnProcess(fakeProcess1);
        const manager = IOSCtrlProxyManager.createForTestingWithDeps(
          physicalDevice,
          fakeTimer,
          undefined,
          fakeExecutor,
        );

        await manager.startIproxyTunnel();

        fakeProcess1.emit("exit", 1, null);
        await Promise.resolve();
        expect(fakeTimer.getPendingTimeouts()).toEqual([1000]);

        fakeExecutor.setNextSpawnProcess(fakeProcess2);
        fakeTimer.advanceTime(1000);
        for (let i = 0; i < 5; i++) {
          await Promise.resolve();
        }

        expect(fakeExecutor.getSpawnedProcesses().length).toBe(2);
        // Missing PID startup yields a turn to capture an asynchronous spawn error.
        fakeTimer.advanceTime(0);
        for (let i = 0; i < 20; i++) {
          await Promise.resolve();
        }
        expect(fakeTimer.getPendingTimeouts()).toEqual([2000]);
      });
    });
  });
});
