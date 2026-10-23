import { IosRunnerLaunchFailures } from "../../src/ctrlProxy/ios/IosRunnerLaunchFailure";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { DefaultIosTunnelClient } from "../../src/ctrlProxy/ios/IosTunnelClient";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import type {
  IosCtrlProxyLifecycleSteps,
  IosCtrlProxyStepOverrides,
} from "../../src/ctrlProxy/ios/IosCtrlProxyLifecycleSteps";
import { IosCtrlProxyBuilder } from "../../src/ctrlProxy/IosCtrlProxyBuilder";
import { DeviceAppManager } from "../../src/utils/ios-cmdline-tools/DeviceAppManager";
import { createExecResult } from "../../src/utils/execResult";
import { PortManager } from "../../src/utils/PortManager";
import { logger } from "../../src/utils/logger";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

function getTunnel(manager: IOSCtrlProxyManager): DefaultIosTunnelClient {
  const client = manager.diagnostics.tunnelClient;
  if (!(client instanceof DefaultIosTunnelClient)) {
    throw new Error("Expected default tunnel");
  }
  return client;
}

type RemoteRunner = NonNullable<
  Parameters<typeof IOSCtrlProxyManager.createForTestingWithDeps>[0]["remoteRunner"]
>;
const simulator = {
  platform: "ios" as const,
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  name: "iPhone",
};
const physical = { ...simulator, deviceId: "00008030-001E28C11E" };

function remoteRunner(): RemoteRunner {
  return {
    isEnabled: () => true,
    isRunningInDocker: () => true,
    isAvailable: async () => true,
    getHost: () => "remote-host",
    runIdeviceId: async () => ({ success: true, data: { stdout: "" } }),
    runIdeviceInstaller: async () => ({ success: true, data: { stdout: "" } }),
    runSimctl: async () => ({ success: true, data: { stdout: "" } }),
    startIproxy: async () => ({ success: true, data: { pid: 99 } }),
    stopIproxy: async () => ({ success: true }),
    getIproxyStatus: async () => ({ success: true, data: { running: true } }),
    start: async () => ({ success: true, data: { pid: 123, message: "started" } }),
    stop: async () => ({ success: true }),
    status: async () => ({ success: true, data: { running: false } }),
  };
}

/**
 * Setup reads the installed app hash through DeviceAppManager. The default instance would spawn a
 * real `xcrun simctl get_app_container` on macOS (Linux skips it), so inject one whose executor
 * answers "no installed app" without touching the host.
 */
function fakeDeviceAppManager(): DeviceAppManager {
  return new DeviceAppManager({
    platform: () => "darwin",
    execute: async () => createExecResult("", ""),
    readFile: async () => "",
    mkdtemp: async () => "/tmp/flattening-device-app-manager",
    rm: async () => undefined,
    readdir: async () => [],
    stat: async () => ({ isDirectory: () => false }),
    tmpdir: () => "/tmp",
    logger: { debug: () => {}, warn: () => {} },
  });
}

describe("IOSCtrlProxyManager flattening characterization", () => {
  let timer: FakeTimer;
  const restores: Array<() => void> = [];

  beforeEach(() => {
    timer = new FakeTimer();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  });
  afterEach(() => {
    for (const restore of restores.reverse()) {
      restore();
    }
    restores.length = 0;
    timer.reset();
    PortManager.reset();
    PortManager.setPortAvailabilityCheckerForTesting(null);
  });

  function makeManager(
    device = simulator,
    remote = remoteRunner(),
    steps?: IosCtrlProxyStepOverrides,
  ) {
    return IOSCtrlProxyManager.createForTestingWithOptions({
      device,
      timer,
      processExecutor: new FakeProcessExecutor(),
      remoteRunner: remote,
      hostPortAvailabilityChecker: { isAvailable: async () => true },
      steps,
    });
  }

  test.each(["spawned", "adopted"])(
    "retracking a %s PID clears its previous launch failure",
    async (mode) => {
      const remote = remoteRunner();
      remote.status = async () => ({
        success: true,
        data: { running: true, pid: 123, port: 8767 },
      });
      const manager = makeManager(simulator, remote);
      const child = new FakeChildProcess(timer);
      child.pid = 123;
      manager.trackStartedXcodebuild(child);
      child.stdout.emit("data", "CtrlProxy listener failed: Address already in use");
      const clearFailure = IosRunnerLaunchFailures.prototype.clear;
      const clear = spyOn(IosRunnerLaunchFailures.prototype, "clear").mockImplementation(function (
        this: IosRunnerLaunchFailures,
        pid: number,
      ) {
        expect(this.get(pid)?.reason).toBe("listener-bind-failed");
        clearFailure.call(this, pid);
        expect(this.get(pid)).toBeUndefined();
      });
      restores.push(() => clear.mockRestore());
      if (mode === "adopted") {
        expect(await manager.startOnSimulator()).toBe("adopted");
      } else {
        manager.trackStartedXcodebuild(child);
      }
      expect(manager.getXcTestProcessId()).toBe(123);
      expect(clear).toHaveBeenCalledWith(123);
    },
  );

  test.each(["installed", "absent", "failed", "missing data", "throws"])(
    "remote installation: %s preserves result, cache, and warning",
    async (branch) => {
      const remote = remoteRunner();
      const manager = makeManager(physical, remote);
      const failure = new Error("installer unavailable");
      const installer = spyOn(remote, "runIdeviceInstaller").mockImplementation(async () => {
        if (branch === "throws") {
          throw failure;
        }
        if (branch === "failed") {
          return { success: false };
        }
        if (branch === "missing data") {
          return { success: true };
        }
        return {
          success: true,
          data: { stdout: branch === "installed" ? IOSCtrlProxyManager.BUNDLE_ID : "" },
        };
      });
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      restores.push(
        () => installer.mockRestore(),
        () => warn.mockRestore(),
      );
      expect(await manager.isInstalled()).toBe(branch === "installed");
      expect(await manager.isInstalled()).toBe(branch === "installed");
      expect(installer).toHaveBeenCalledTimes(branch === "throws" ? 2 : 1);
      expect(installer).toHaveBeenCalledWith(["-u", physical.deviceId, "-l"]);
      expect(warn.mock.calls).toEqual(
        branch === "throws"
          ? Array.from({ length: 2 }, () => [
              "[IOSCtrlProxy] Error checking installation: Error: installer unavailable",
            ])
          : [],
      );
    },
  );

  test.each(["ready", "waited", "build", "failed build", "prefetch throws"])(
    "setup build selection: %s preserves await/log order and retry admission",
    async (branch) => {
      const events: string[] = [];
      const builder = IosCtrlProxyBuilder.getInstance();
      const legacy = mock(async () => {});
      const manager = IOSCtrlProxyManager.createForTestingWithOptions({
        device: simulator,
        timer,
        builder,
        processExecutor: new FakeProcessExecutor(),
        deviceAppManager: fakeDeviceAppManager(),
        steps: { uninstallLegacyAppIfPresent: legacy },
      });
      const result = { success: branch !== "failed build", message: "built", error: "build error" };
      const pin = spyOn(IosCtrlProxyBuilder, "isPinnedVersionUnverifiable").mockReturnValue(false);
      const running = spyOn(manager, "isRunning").mockResolvedValue(false);
      const needs = spyOn(builder, "needsRebuild").mockImplementation(async () => {
        events.push("needs");
        return true;
      });
      const cached = spyOn(IosCtrlProxyBuilder, "getPrefetchedResult").mockImplementation(() => {
        events.push("cached");
        return branch === "ready" ? result : null;
      });
      const waited = spyOn(IosCtrlProxyBuilder, "waitForPrefetch").mockImplementation(async () => {
        events.push("wait");
        if (branch === "prefetch throws") {
          throw new Error("prefetch unavailable");
        }
        return branch === "waited" ? result : null;
      });
      const build = spyOn(builder, "build").mockImplementation(async () => {
        events.push("build");
        return result;
      });
      const start = spyOn(manager, "start").mockImplementation(async () => {
        events.push("start");
      });
      const info = spyOn(logger, "info").mockImplementation((message) => {
        events.push(message);
      });
      restores.push(
        ...[pin, running, needs, cached, waited, build, start, info].map(
          (mock) => () => mock.mockRestore(),
        ),
      );
      const setup = await manager.setup();
      expect(setup.success).toBe(!["failed build", "prefetch throws"].includes(branch));
      expect(manager.diagnostics.attemptedSetup).toBe(setup.success);
      if (branch === "prefetch throws") {
        expect(setup).toEqual({
          success: false,
          message: "Failed to setup CtrlProxy",
          error: "prefetch unavailable",
          recoveryInterrupted: false,
          perfTiming: null,
        });
      } else {
        expect(setup.buildResult).toBe(result);
        expect(setup.message).toBe(
          branch === "failed build" ? "built" : "CtrlProxy downloaded and started successfully",
        );
      }
      const expected = ["needs", "cached"];
      if (branch !== "ready") {
        expected.push("wait");
      }
      if (branch === "ready") {
        expected.push("[IOSCtrlProxy] Using prefetched build result");
      }
      if (branch === "waited") {
        expected.push("[IOSCtrlProxy] Using completed prefetch build result");
      }
      if (["build", "failed build"].includes(branch)) {
        expected.push("[IOSCtrlProxy] Downloading CtrlProxy bundle", "build");
      }
      if (setup.success) {
        expected.push("start");
      }
      expect(events).toEqual(expected);
    },
  );

  test.each([true, false])(
    "live remote iproxy returns before stop/spawn (supervise=%s)",
    async (supervise) => {
      const remote = remoteRunner();
      const manager = makeManager(physical, remote);
      getTunnel(manager).setStateForTesting({ processId: 99 });
      const stop = spyOn(remote, "stopIproxy");
      const spawn = spyOn(remote, "startIproxy");
      const supervisor = spyOn(
        getTunnel(manager).diagnostics.supervisor,
        "start",
      ).mockResolvedValue();
      restores.push(...[stop, spawn, supervisor].map((mock) => () => mock.mockRestore()));
      await manager.startIproxyTunnel({ supervise });
      expect(stop).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(supervisor).toHaveBeenCalledTimes(supervise ? 1 : 0);
    },
  );

  test.each(["success", "failed", "missing data", "throws"])(
    "remote tunnel launch: %s preserves stop/port/spawn/poll/supervision order",
    async (branch) => {
      const remote = remoteRunner();
      const manager = makeManager(physical, remote);
      getTunnel(manager).setStateForTesting({ processId: 98 });
      getTunnel(manager).setStateForTesting({ devicePort: 9100 });
      const events: string[] = [];
      const failure = new Error("spawn unavailable");
      const status = spyOn(remote, "getIproxyStatus").mockImplementation(async () => {
        events.push("status");
        return { success: false };
      });
      const stop = spyOn(getTunnel(manager), "stop").mockImplementation(async (options) => {
        expect(options).toEqual({ stopSupervisor: true });
        events.push("stop");
        getTunnel(manager).setStateForTesting({ processId: null });
        getTunnel(manager).setStateForTesting({ devicePort: null });
      });
      const port = spyOn(manager, "ensureRemoteServicePortAvailable").mockImplementation(
        async (options) => {
          expect(options).toEqual({ allowReallocation: false });
          events.push("port");
        },
      );
      const spawn = spyOn(remote, "startIproxy").mockImplementation(async (options) => {
        expect(options).toEqual({ deviceId: physical.deviceId, localPort: 8765, devicePort: 9100 });
        events.push("spawn");
        if (branch === "throws") {
          throw failure;
        }
        if (branch === "failed") {
          return { success: false, error: "remote refused" };
        }
        return branch === "missing data" ? { success: true } : { success: true, data: { pid: 99 } };
      });
      const poll = spyOn(getTunnel(manager), "waitForStartup").mockImplementation(async () => {
        expect(getTunnel(manager).diagnostics.processId).toBe(99);
        expect(getTunnel(manager).diagnostics.devicePort).toBe(9100);
        expect(getTunnel(manager).diagnostics.process).toBeNull();
        events.push("poll");
      });
      const supervisor = spyOn(
        getTunnel(manager).diagnostics.supervisor,
        "start",
      ).mockImplementation(async () => {
        events.push("supervision");
      });
      restores.push(
        ...[status, stop, port, spawn, poll, supervisor].map((mock) => () => mock.mockRestore()),
      );
      const starting = manager.startIproxyTunnel({ allowServicePortReallocation: false });
      if (branch === "success") {
        await starting;
      } else {
        await expect(starting).rejects.toThrow(
          branch === "throws"
            ? failure
            : branch === "failed"
              ? "remote refused"
              : "Failed to start iproxy tunnel via remote runner",
        );
        expect(getTunnel(manager).diagnostics.processId).toBeNull();
      }
      expect(events).toEqual(
        branch === "success"
          ? ["status", "stop", "port", "spawn", "poll", "supervision"]
          : ["status", "stop", "port", "spawn"],
      );
    },
  );

  test("remote iproxy polls false/missing status before success without sleeping after success", async () => {
    const remote = remoteRunner();
    const manager = makeManager(physical, remote);
    getTunnel(manager).setStateForTesting({ processId: 99 });
    const events: string[] = [];
    let calls = 0;
    const status = spyOn(remote, "getIproxyStatus").mockImplementation(async ({ pid }) => {
      events.push(`status:${pid}`);
      calls++;
      if (calls === 1) {
        return { success: false };
      }
      if (calls === 2) {
        return { success: true };
      }
      return { success: true, data: { running: true } };
    });
    const sleep = spyOn(timer, "sleep").mockImplementation(async (ms) => {
      events.push(`sleep:${ms}`);
      timer.advanceTime(ms);
    });
    restores.push(
      () => status.mockRestore(),
      () => sleep.mockRestore(),
    );
    await getTunnel(manager).waitForStartup();
    expect(events).toEqual(["status:99", "sleep:100", "status:99", "sleep:100", "status:99"]);
  });

  test.each(["missing pid", "throws", "deadline"])("iproxy startup exit: %s", async (branch) => {
    const remote = remoteRunner();
    const manager = makeManager(physical, remote);
    if (branch !== "missing pid") {
      getTunnel(manager).setStateForTesting({ processId: 99 });
    }
    const failure = new Error("status unavailable");
    const status = spyOn(remote, "getIproxyStatus").mockImplementation(async () => {
      if (branch === "throws") {
        throw failure;
      }
      return { success: false };
    });
    const sleep = spyOn(timer, "sleep").mockImplementation(async (ms) => {
      timer.advanceTime(ms);
    });
    const timeout = spyOn(getTunnel(manager), "getStartTimeoutMs").mockReturnValue(200);
    restores.push(...[status, sleep, timeout].map((mock) => () => mock.mockRestore()));
    await expect(getTunnel(manager).waitForStartup()).rejects.toThrow(
      branch === "throws" ? failure : "iproxy failed to stay running within 200ms",
    );
    expect(sleep).toHaveBeenCalledTimes(branch === "throws" ? 0 : 2);
    expect(status).toHaveBeenCalledTimes(
      branch === "missing pid" ? 0 : branch === "throws" ? 1 : 2,
    );
  });

  test.each(["graceful", "forced", "foreign", "wedged"])(
    "listener cleanup preserves loop exits: %s",
    async (branch) => {
      const events: string[] = [];
      const manager = IOSCtrlProxyManager.createForTestingWithDeps({
        device: simulator,
        timer,
        builder: undefined,
        processExecutor: new FakeProcessExecutor(),
      });
      const owned = { pid: 5555, port: 8765, command: "xcodebuild" };
      const foreign = { pid: 5556, port: 8765, command: "foreign" };
      let probes = 0;
      const listeners = spyOn(
        manager.diagnostics.processClient,
        "findListeningPids",
      ).mockImplementation(async () => {
        probes++;
        events.push(`probe:${probes}`);
        if (probes === 1) {
          return [owned.pid];
        }
        if (branch === "graceful") {
          return [];
        }
        if (probes === 2 || branch === "wedged") {
          return [owned.pid];
        }
        return probes === 3 && branch === "foreign" ? [foreign.pid] : [];
      });
      const ownership = spyOn(
        manager.diagnostics.processClient,
        "hasDeviceIdentity",
      ).mockImplementation((command) => command === owned.command);
      const runner = spyOn(
        manager.diagnostics.processClient,
        "isCtrlProxyRunnerCommand",
      ).mockReturnValue(true);
      const root = spyOn(manager.diagnostics.processClient, "getProcessInfo").mockImplementation(
        async (pid) =>
          pid === 4444
            ? {
                command:
                  "sh xcodebuild test-without-building -xctestrun /tmp/CtrlProxy.xctestrun platform=iOS Simulator -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
                ppid: 1,
              }
            : {
                command: pid === owned.pid ? owned.command : foreign.command,
                ppid: pid === owned.pid ? 4444 : 1,
              },
      );
      const terminate = spyOn(
        manager.diagnostics.processClient,
        "terminateProcessTree",
      ).mockImplementation(async (pid) => {
        events.push(`terminate:${pid}`);
        if (branch !== "graceful") {
          throw new Error("survived");
        }
      });
      const warn = spyOn(logger, "warn").mockImplementation((message) => {
        events.push(message);
      });
      restores.push(
        ...[listeners, ownership, runner, root, terminate, warn].map(
          (mock) => () => mock.mockRestore(),
        ),
      );
      if (branch === "wedged") {
        await expect(manager.ensureServicePortReadyForLaunch()).rejects.toThrow(
          "CtrlProxy recovery failed, port 8765 still held by PID 5555 (cmd: xcodebuild)",
        );
      } else {
        await manager.ensureServicePortReadyForLaunch();
      }
      const expected = [
        "probe:1",
        "[IOSCtrlProxy] Terminating stale CtrlProxy process tree rooted at 4444 for listener 5555 on port 8765",
        "terminate:4444",
      ];
      if (branch !== "graceful") {
        expected.push("[IOSCtrlProxy] Stale runner tree 4444 survived termination: survived");
      }
      expected.push("probe:2");
      if (branch !== "graceful") {
        expected.push(
          "[IOSCtrlProxy] CtrlProxy listener 5555 still holds port 8765; force-terminating remaining owned process tree",
          "terminate:5555",
          "[IOSCtrlProxy] Listener 5555 survived forced termination: survived",
          "probe:3",
        );
      }
      if (branch === "foreign") {
        expected.push(
          "[IOSCtrlProxy] Port 8765 is held by a foreign process; reallocating CtrlProxy port",
          "probe:4",
        );
      }
      expect(events).toEqual(expected);
      expect(manager.getServicePort()).toBe(branch === "foreign" ? 8767 : 8765);
    },
  );

  test.each(["success", "collision", "other error"])(
    "alive physical startup preserves tunnel recovery: %s",
    async (branch) => {
      const events: string[] = [];
      const health = mock<IosCtrlProxyLifecycleSteps["waitForHealthEndpoint"]>(async () => {
        events.push("health");
        return true;
      });
      const complete = mock<IosCtrlProxyLifecycleSteps["completeHealthStartup"]>(async () => {
        events.push("complete");
      });
      const restart = mock<IosCtrlProxyLifecycleSteps["startOnDevice"]>(async () => {
        events.push("restart");
        return "spawned";
      });
      const remote = remoteRunner();
      const manager = makeManager(physical, remote, {
        waitForHealthEndpoint: health,
        completeHealthStartup: complete,
        startOnDevice: restart,
      });
      manager.testHooks.setState({ xcTestProcessId: 123 });
      let failure: unknown = new Error("tunnel unavailable");
      if (branch === "collision") {
        const available = spyOn(
          manager.diagnostics.hostPortAvailabilityChecker,
          "isAvailable",
        ).mockResolvedValue(false);
        try {
          await manager.ensureRemoteServicePortAvailable({ allowReallocation: false });
        } catch (error) {
          failure = error;
        }
        available.mockRestore();
      }
      const alive = spyOn(remote, "status").mockResolvedValue({
        success: true,
        data: { running: true, pid: 123 },
      });
      const tunnel = spyOn(manager, "startIproxyTunnel").mockImplementation(async (options) => {
        expect(options).toEqual({ allowServicePortReallocation: false });
        events.push("tunnel");
        if (branch !== "success") {
          throw failure;
        }
      });
      const iproxy = spyOn(getTunnel(manager).diagnostics.supervisor, "start").mockImplementation(
        async () => {
          events.push("iproxy supervision");
        },
      );
      const supervision = spyOn(manager.diagnostics.processSupervisor, "start").mockImplementation(
        async () => {
          events.push("supervision");
        },
      );
      const running = spyOn(manager, "isRunning").mockImplementation(async () => {
        events.push("running");
        return false;
      });
      const warn = spyOn(logger, "warn").mockImplementation((message) => {
        events.push(message);
      });
      restores.push(
        ...[alive, tunnel, iproxy, supervision, running, warn].map(
          (mock) => () => mock.mockRestore(),
        ),
      );
      const shared = {
        controller: new AbortController(),
        completion: Promise.resolve(),
        healthPollDeadlineMs: null,
        defaultHealthPollDeadlineMs: null,
        callerHealthPollDeadlinesMs: new Map<symbol, number>(),
        teardownCommitted: false,
        waitingCallers: 1,
        externalWaitingCallers: 1,
        completed: false,
      };
      if (branch === "other error") {
        await expect(manager.startInternal(shared)).rejects.toBe(failure);
      } else {
        await manager.startInternal(shared);
      }
      expect(events).toEqual(
        branch === "success"
          ? ["tunnel", "iproxy supervision", "supervision"]
          : branch === "other error"
            ? ["tunnel"]
            : [
                "tunnel",
                "[IOSCtrlProxy] Existing CtrlProxy process uses a host port that is no longer available; restarting",
                "restart",
                "health",
                "complete",
              ],
      );
    },
  );

  test("remote hung-runner stop rejection still clears ownership and rearms supervision before timeout", async () => {
    const remote = remoteRunner();
    const own = mock<IosCtrlProxyLifecycleSteps["isOwnRunnerProcessAlive"]>(async () => true);
    const health = mock<IosCtrlProxyLifecycleSteps["waitForHealthEndpoint"]>(async () => false);
    const manager = makeManager(simulator, remote, {
      isOwnRunnerProcessAlive: own,
      waitForHealthEndpoint: health,
    });
    manager.testHooks.setState({ xcTestProcessId: 123 });
    const events: string[] = [];
    const alive = spyOn(remote, "status").mockResolvedValue({
      success: true,
      data: { running: false },
    });
    const running = spyOn(manager, "isRunning").mockResolvedValue(false);
    const stop = spyOn(remote, "stop").mockImplementation(async (options) => {
      expect(options).toEqual({ deviceId: simulator.deviceId, pid: 123 });
      events.push("remote stop");
      throw new Error("remote stop unavailable");
    });
    const cache = spyOn(manager, "clearCaches").mockImplementation(() => {
      events.push("cache");
    });
    const supervisorStop = spyOn(manager.diagnostics.processSupervisor, "stop").mockImplementation(
      () => {
        events.push("supervisor stop");
      },
    );
    const supervisorStart = spyOn(
      manager.diagnostics.processSupervisor,
      "start",
    ).mockImplementation(async () => {
      expect(manager.diagnostics.isStopping).toBe(true);
      expect(manager.diagnostics.xcTestProcessId).toBeNull();
      events.push("supervisor start");
    });
    const listeners = spyOn(
      manager.diagnostics.processClient,
      "findListeningPids",
    ).mockImplementation(async () => {
      events.push("listeners");
      return [];
    });
    const warn = spyOn(logger, "warn").mockImplementation((message) => {
      events.push(message);
    });
    restores.push(
      ...[alive, running, stop, cache, supervisorStop, supervisorStart, listeners, warn].map(
        (mock) => () => mock.mockRestore(),
      ),
    );
    const shared = {
      controller: new AbortController(),
      completion: Promise.resolve(),
      healthPollDeadlineMs: null,
      defaultHealthPollDeadlineMs: null,
      callerHealthPollDeadlinesMs: new Map<symbol, number>(),
      teardownCommitted: false,
      waitingCallers: 1,
      externalWaitingCallers: 1,
      completed: false,
    };
    await expect(manager.startInternal(shared)).rejects.toThrow(
      "CtrlProxy failed to start within timeout (30s)",
    );
    expect(events).toEqual([
      "[IOSCtrlProxy] Runner launch progress sample unavailable",
      "[IOSCtrlProxy] Deferred-to CtrlProxy runner (PID 123) never became healthy within 30s; terminating it so the next start spawns a fresh runner",
      "remote stop",
      "[IOSCtrlProxy] Remote runner stop of hung runner 123 failed: remote stop unavailable",
      "cache",
      "supervisor stop",
      "supervisor start",
      "listeners",
    ]);
    expect(shared.teardownCommitted).toBe(true);
    expect(manager.diagnostics.isStopping).toBe(false);
  });
});
