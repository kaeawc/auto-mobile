import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { DefaultIosTunnelClient } from "../../src/ctrlProxy/ios/IosTunnelClient";
import { PortManager } from "../../src/utils/PortManager";
import { logger } from "../../src/utils/logger";
import { FakeIosTunnelClient } from "../fakes/FakeIosTunnelClient";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeTimer } from "../fakes/FakeTimer";

const device = { platform: "ios" as const, deviceId: "00008030-001E28C11E", name: "iPhone" };
type RemoteRunner = NonNullable<Parameters<typeof IOSCtrlProxyManager.createForTestingWithDeps>[6]>;
const restores: Array<() => void> = [];
const timers: FakeTimer[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
  for (const timer of timers.splice(0)) {
    timer.reset();
  }
  PortManager.reset();
  PortManager.setPortAvailabilityCheckerForTesting(null);
});
function keep(mock: { mockRestore(): void }): void {
  restores.push(() => mock.mockRestore());
}
function timerFixture(): FakeTimer {
  const timer = new FakeTimer();
  timers.push(timer);
  PortManager.setPortAvailabilityCheckerForTesting({ isPortAvailable: () => true });
  return timer;
}
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}
function fakeFixture() {
  const timer = timerFixture();
  const fake = new FakeIosTunnelClient();
  const manager = IOSCtrlProxyManager.createForTesting(device, timer, undefined, fake);
  manager["servicePort"] = 8765;
  return { timer, fake, manager };
}
function realFixture(remoteMode = false) {
  const timer = timerFixture();
  const events: string[] = [];
  const children: FakeChildProcess[] = [];
  const executor = new (class extends FakeProcessExecutor {
    override spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess {
      events.push(`spawn:${command}:${args.join(",")}`);
      const child = new FakeChildProcess(timer);
      child.simulateSpawn = () => {};
      child.kill = (signal) => {
        events.push(`kill:${signal ?? "SIGTERM"}`);
        child.killed = true;
        child.exitCode = 0;
        child.emit("exit", 0, null);
        return true;
      };
      children.push(child);
      this.setNextSpawnProcess(child);
      return super.spawn(command, args, options);
    }
  })();
  const remote: RemoteRunner = {
    isEnabled: () => remoteMode,
    isRunningInDocker: () => remoteMode,
    isAvailable: async () => true,
    getHost: () => "fake-host",
    runIdeviceId: async () => ({ success: true, data: { stdout: device.deviceId } }),
    runIdeviceInstaller: async () => ({ success: true, data: { stdout: "" } }),
    runSimctl: async () => ({ success: true, data: { stdout: "" } }),
    start: async () => ({ success: true, data: { pid: 456, message: "started" } }),
    stop: async () => {
      events.push("runner-stop");
      return { success: true };
    },
    status: async () => ({ success: true, data: { running: false } }),
    startIproxy: async ({ localPort, devicePort, deviceId }) => {
      events.push(`remote-spawn:${localPort},${devicePort},${deviceId}`);
      return { success: true, data: { pid: 123 } };
    },
    stopIproxy: async ({ pid }) => {
      events.push(`remote-stop:${pid}`);
      return { success: true };
    },
    getIproxyStatus: async ({ pid }) => {
      events.push(`status:${pid}`);
      return { success: true, data: { running: true } };
    },
  };
  const manager = IOSCtrlProxyManager.createForTestingWithDeps(
    device,
    timer,
    undefined,
    executor,
    undefined,
    undefined,
    remote,
    { isAvailable: async () => true },
  );
  manager["servicePort"] = 8765;
  const isRunning = manager["isProcessRunning"].bind(manager);
  keep(
    spyOn(manager, "isProcessRunning").mockImplementation((pid) => {
      events.push(`running:${pid}`);
      return isRunning(pid);
    }),
  );
  keep(
    spyOn(manager, "ensureRemoteServicePortAvailable").mockImplementation(async () => {
      events.push("port-check");
    }),
  );
  const client = manager["tunnelClient"];
  if (!(client instanceof DefaultIosTunnelClient)) {
    throw new Error("Expected default tunnel");
  }
  const supervisor = client["iproxySupervisor"];
  const start = supervisor.start.bind(supervisor);
  const stop = supervisor.stop.bind(supervisor);
  keep(
    spyOn(supervisor, "start").mockImplementation(() => {
      events.push("supervise");
      return start();
    }),
  );
  keep(
    spyOn(supervisor, "stop").mockImplementation(() => {
      events.push("unsupervise");
      stop();
    }),
  );
  return { timer, events, executor, children, manager, client, remote, supervisor };
}

describe("manager tunnel calls with FakeIosTunnelClient", () => {
  test("start, explicit undefined device port, restart and stop keep their arguments and order", async () => {
    const { manager, fake } = fakeFixture();
    await manager["startIproxyTunnel"]({ devicePort: undefined });
    manager["servicePort"] = 8766;
    await manager["restartIproxyTunnel"]();
    await manager["stopIproxyTunnel"]({ clearDevicePort: true });
    expect(fake.calls).toEqual(["start", "start", "stop"]);
    expect(fake.starts).toEqual([
      { localPort: 8765, devicePort: 8765, udid: device.deviceId },
      {
        localPort: 8766,
        devicePort: 8766,
        udid: device.deviceId,
        supervise: false,
        allowServicePortReallocation: false,
      },
    ]);
    expect(fake.stops).toEqual([{ clearDevicePort: true }]);
  });
  test("remote start and restart preserve the computed device port when explicitly undefined", async () => {
    const { manager, fake } = fakeFixture();
    keep(spyOn(manager, "useRemoteRunner").mockReturnValue(true));
    fake.devicePort = 9100;
    await manager["startIproxyTunnel"]({ devicePort: undefined });
    manager["servicePort"] = 8766;
    await manager["restartIproxyTunnel"]();
    expect(fake.calls).toEqual(["start", "start"]);
    expect(fake.starts).toEqual([
      { localPort: 8765, devicePort: 9100, udid: device.deviceId },
      {
        localPort: 8766,
        devicePort: 9100,
        udid: device.deviceId,
        supervise: false,
        allowServicePortReallocation: false,
      },
    ]);
  });
  test("local undefined uses the service port and remote defined overrides the retained port", async () => {
    const { manager, fake } = fakeFixture();
    fake.devicePort = 9100;
    await manager["startIproxyTunnel"]({ devicePort: undefined });
    expect(fake.starts[0].devicePort).toBe(8765);
    keep(spyOn(manager, "useRemoteRunner").mockReturnValue(true));
    await manager["startIproxyTunnel"]({ devicePort: 9200 });
    expect(fake.starts[1].devicePort).toBe(9200);
  });
  test.each(["start", "readiness"])(
    "%s failure propagates without manager cleanup",
    async (path) => {
      const { manager, fake } = fakeFixture();
      const failure = new Error(`${path} failed`);
      if (path === "start") {
        fake.startError = failure;
      } else {
        fake.readinessError = failure;
      }
      await expect(manager["startIproxyTunnel"]()).rejects.toBe(failure);
      expect(fake.calls).toEqual(["start"]);
      expect(fake.starts).toEqual([{ localPort: 8765, devicePort: 8765, udid: device.deviceId }]);
      expect(fake.stops).toEqual([]);
      expect(fake.localPort).toBe(path === "readiness" ? 8765 : null);
    },
  );
  test("unexpected-exit restart callback delegates a single unsupervised start", async () => {
    const { manager, fake } = fakeFixture();
    await manager["startIproxyTunnel"]();
    fake.alive = false;
    fake.localPort = null;
    await manager["restartIproxyTunnel"]();
    expect(fake.calls).toEqual(["start", "start"]);
    expect(fake.starts[1]).toEqual({
      localPort: 8765,
      devicePort: 8765,
      udid: device.deviceId,
      supervise: false,
      allowServicePortReallocation: false,
    });
    expect(fake.stops).toEqual([]);
  });
  test("forced shutdown prepares synchronously before port release, then invokes its kill", async () => {
    const { manager, fake } = fakeFixture();
    keep(
      spyOn(PortManager, "release").mockImplementation(() => {
        expect(fake.calls).toEqual(["prepareForcedStop"]);
      }),
    );
    await manager["forceStopForShutdown"](5000);
    expect(fake.calls).toEqual(["prepareForcedStop", "forceKill"]);
    expect(fake.forcedStops).toBe(1);
  });
});

describe("manager with DefaultIosTunnelClient over fake processes", () => {
  test("local start and stop preserve spawn argv, stdio, supervision and kill order", async () => {
    const { manager, events, children, executor } = realFixture();
    await manager["startIproxyTunnel"]({ devicePort: 9100 });
    const child = children[0];
    expect(events).toEqual([
      "unsupervise",
      `spawn:iproxy:8765,8765,${device.deviceId}`,
      `running:${child.pid}`,
      "supervise",
    ]);
    expect(executor.getSpawnedProcesses()[0].options).toEqual({
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(Object.values(manager)).not.toContain(child);
    expect(Object.values(manager)).not.toContain(child.pid);
    events.length = 0;
    await manager["stopIproxyTunnel"]({ clearDevicePort: true });
    expect(events).toEqual(["unsupervise", "kill:SIGTERM"]);
  });
  test.each([false, true])(
    "restart remote=%s preserves current local and original remote ports",
    async (remoteMode) => {
      const { manager, client, children, events } = realFixture(remoteMode);
      await manager["startIproxyTunnel"]({ devicePort: 9100 });
      manager["servicePort"] = 8766;
      // The supervisor clears PID/child tracking before invoking the manager restart callback.
      if (remoteMode) {
        client["iproxyProcessId"] = null;
      } else {
        children[0].emit("exit", 1, null);
      }
      await flush();
      events.length = 0;
      await manager["restartIproxyTunnel"]();
      expect(events).toEqual(
        remoteMode
          ? ["port-check", `remote-spawn:8766,9100,${device.deviceId}`, "status:123"]
          : [`spawn:iproxy:8766,8766,${device.deviceId}`, `running:${children[1].pid}`],
      );
      expect(client.devicePort).toBe(remoteMode ? 9100 : null);
    },
  );
  test("remote start and stop retain stop-port-spawn-poll-supervise order", async () => {
    const { manager, client, events, remote } = realFixture(true);
    client["iproxyProcessId"] = 122;
    client["iproxyDevicePort"] = 9100;
    client["iproxyLocalPort"] = 8764;
    remote.getIproxyStatus = async ({ pid }) => {
      events.push(`status:${pid}`);
      return { success: true, data: { running: pid === 123 } };
    };
    await manager["startIproxyTunnel"]({ devicePort: undefined });
    expect(events).toEqual([
      "status:122",
      "unsupervise",
      "remote-stop:122",
      "port-check",
      `remote-spawn:8765,9100,${device.deviceId}`,
      "status:123",
      "supervise",
    ]);
    events.length = 0;
    await manager["stopIproxyTunnel"]({ clearDevicePort: true });
    expect(events).toEqual(["unsupervise", "remote-stop:123"]);
    expect(client.localPort).toBeNull();
    expect(client.devicePort).toBeNull();
  });
  test("local no-PID and spawn exceptions retain exact errors without a second stop", async () => {
    const { manager, executor, events, client, timer } = realFixture();
    const noPid = new FakeChildProcess();
    // Exercise the no-event fallback without a real timer.
    timer.enableAutoAdvance();
    noPid.pid = undefined;
    noPid.simulateSpawn = () => {};
    keep(spyOn(executor, "spawn").mockReturnValue(noPid));
    await expect(manager["startIproxyTunnel"]()).rejects.toEqual(
      new Error("Failed to start iproxy tunnel (no PID)"),
    );
    expect(events).toEqual(["unsupervise"]);
    expect(client.localPort).toBeNull();
    const failure = new Error("spawn unavailable");
    keep(
      spyOn(executor, "spawn").mockImplementation(() => {
        throw failure;
      }),
    );
    await expect(manager["startIproxyTunnel"]()).rejects.toBe(failure);
    expect(events).toEqual(["unsupervise", "unsupervise"]);
  });
  test.each(["throws", "failed", "missing data"])(
    "remote startup %s preserves the original error and side effects",
    async (branch) => {
      const { manager, remote, events, client } = realFixture(true);
      const failure = new Error("remote refused");
      remote.startIproxy = async () => {
        events.push("remote-spawn");
        if (branch === "throws") {
          throw failure;
        }
        return branch === "failed" ? { success: false, error: failure.message } : { success: true };
      };
      const starting = manager["startIproxyTunnel"]();
      if (branch === "throws") {
        await expect(starting).rejects.toBe(failure);
      } else {
        await expect(starting).rejects.toEqual(
          new Error(
            branch === "failed"
              ? failure.message
              : "Failed to start iproxy tunnel via remote runner",
          ),
        );
      }
      expect(events).toEqual(["unsupervise", "port-check", "remote-spawn"]);
      expect(client.localPort).toBeNull();
    },
  );
  test.each([false, true])(
    "supervision startup failure remote=%s keeps the original error and tracked tunnel",
    async (remoteMode) => {
      const { manager, client, supervisor, events } = realFixture(remoteMode);
      const failure = new Error("supervision failed");
      keep(
        spyOn(supervisor, "start").mockImplementation(async () => {
          events.push("supervision-failed");
          throw failure;
        }),
      );
      await expect(manager["startIproxyTunnel"]()).rejects.toBe(failure);
      expect(client.localPort).toBe(8765);
      expect(events.filter((event) => event === "unsupervise")).toEqual(["unsupervise"]);
      expect(events.at(-1)).toBe("supervision-failed");
    },
  );
  test("remote status exception during actual startup polling leaves PID tracked", async () => {
    const { manager, remote, client, events } = realFixture(true);
    const failure = new Error("status unavailable");
    remote.getIproxyStatus = async () => {
      events.push("status-failed");
      throw failure;
    };
    await expect(manager["startIproxyTunnel"]()).rejects.toBe(failure);
    expect(client["iproxyProcessId"]).toBe(123);
    expect(client.localPort).toBe(8765);
    expect(events).toEqual([
      "unsupervise",
      "port-check",
      `remote-spawn:8765,8765,${device.deviceId}`,
      "status-failed",
    ]);
  });
  test.each([false, true])(
    "readiness failure remote=%s leaves tracking and cannot be masked by stop",
    async (remoteMode) => {
      const { manager, remote, client, children, events } = realFixture(remoteMode);
      const failure = new Error("readiness failed");
      keep(
        spyOn(client, "waitForStartup").mockImplementation(async () => {
          events.push("readiness-failed");
          throw failure;
        }),
      );
      remote.stopIproxy = async () => {
        throw new Error("stop must not run");
      };
      await expect(manager["startIproxyTunnel"]()).rejects.toBe(failure);
      expect(events).toEqual(
        remoteMode
          ? [
              "unsupervise",
              "port-check",
              `remote-spawn:8765,8765,${device.deviceId}`,
              "readiness-failed",
            ]
          : ["unsupervise", `spawn:iproxy:8765,8765,${device.deviceId}`, "readiness-failed"],
      );
      expect(client.localPort).toBe(8765);
      expect(client["iproxyProcessId"]).toBe(remoteMode ? 123 : children[0].pid);
      if (!remoteMode) {
        expect(children[0].killed).toBe(false);
      }
    },
  );
  test.each([false, true])(
    "actual readiness timeout remote=%s retains exact text and tracking",
    async (remoteMode) => {
      const { manager, client, remote, timer, children } = realFixture(remoteMode);
      timer.enableAutoAdvance();
      keep(spyOn(client, "getStartTimeoutMs").mockReturnValue(200));
      keep(spyOn(manager["processClient"], "isRunning").mockResolvedValue(false));
      remote.getIproxyStatus = async () => ({ success: true, data: { running: false } });
      await expect(manager["startIproxyTunnel"]()).rejects.toEqual(
        new Error("iproxy failed to stay running within 200ms"),
      );
      expect(client.localPort).toBe(8765);
      expect(timer.getPendingIntervals()).toEqual([]);
      if (!remoteMode) {
        expect(children[0].killed).toBe(false);
      }
    },
  );
  test.each([false, true])(
    "unexpected child exit consults manager stopping=%s",
    async (stopping) => {
      const { manager, children, timer, events } = realFixture();
      await manager["startIproxyTunnel"]();
      manager["isStopping"] = stopping;
      events.length = 0;
      children[0].emit("exit", 1, null);
      await flush();
      expect(timer.getPendingTimeouts()).toEqual(stopping ? [] : [1000]);
      if (stopping) {
        return;
      }
      timer.advanceTime(1000);
      await flush();
      expect(events).toEqual([
        `spawn:iproxy:8765,8765,${device.deviceId}`,
        `running:${children[1].pid}`,
      ]);
    },
  );
  test("supervise:false stop still reports an exit when manager is not stopping", async () => {
    const { manager, children, supervisor } = realFixture();
    await manager["startIproxyTunnel"]();
    const exited = spyOn(supervisor, "processExited");
    keep(exited);
    await manager["stopIproxyTunnel"]({ stopSupervisor: false });
    expect(exited).toHaveBeenCalledTimes(1);
    expect(children[0].killed).toBe(true);
  });
  test.each([false, true])(
    "stop during readiness remote=%s keeps polling and can arm supervision late",
    async (remoteMode) => {
      const { manager, client, remote, events, timer } = realFixture(remoteMode);
      const entered = Promise.withResolvers<void>();
      const result = Promise.withResolvers<boolean>();
      if (remoteMode) {
        remote.getIproxyStatus = async () => {
          events.push("poll-enter");
          entered.resolve();
          return { success: true, data: { running: await result.promise } };
        };
      } else {
        keep(
          spyOn(manager, "isProcessRunning").mockImplementation(() => {
            events.push("poll-enter");
            entered.resolve();
            return result.promise;
          }),
        );
      }
      const starting = manager["startIproxyTunnel"]();
      await entered.promise;
      await manager["stopIproxyTunnel"]();
      expect(client.localPort).toBeNull();
      result.resolve(true);
      await starting;
      expect(events).toEqual(
        remoteMode
          ? [
              "unsupervise",
              "port-check",
              `remote-spawn:8765,8765,${device.deviceId}`,
              "poll-enter",
              "unsupervise",
              "remote-stop:123",
              "supervise",
            ]
          : [
              "unsupervise",
              `spawn:iproxy:8765,8765,${device.deviceId}`,
              "poll-enter",
              "unsupervise",
              "kill:SIGTERM",
              "supervise",
            ],
      );
      expect(timer.getPendingIntervals()).toHaveLength(1);
    },
  );
  test("stop after a false poll continues missing-PID sleeps to the original timeout", async () => {
    const { manager, client, remote, timer } = realFixture(true);
    const entered = Promise.withResolvers<void>();
    const result = Promise.withResolvers<boolean>();
    remote.getIproxyStatus = async () => {
      entered.resolve();
      return { success: true, data: { running: await result.promise } };
    };
    keep(spyOn(client, "getStartTimeoutMs").mockReturnValue(200));
    const starting = manager["startIproxyTunnel"]();
    await entered.promise;
    await manager["stopIproxyTunnel"]();
    timer.enableAutoAdvance();
    result.resolve(false);
    await expect(starting).rejects.toEqual(new Error("iproxy failed to stay running within 200ms"));
    expect(timer.getSleepHistory()).toEqual([100, 100]);
    expect(timer.getPendingIntervals()).toEqual([]);
  });
  test("forced local kill keeps the old debug message including Error stringification", async () => {
    const { manager, children } = realFixture();
    await manager["startIproxyTunnel"]();
    children[0].kill = () => {
      throw new Error("already exited");
    };
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    keep(debug);
    await manager["forceStopForShutdown"](5000);
    expect(debug).toHaveBeenCalledWith(
      "[IOSCtrlProxy] Forced iproxy termination was already complete: Error: already exited",
    );
  });
  test.each([false, true])(
    "forced shutdown remote=%s preserves detach-release-kill order without warnings",
    async (remoteMode) => {
      const { manager, client, children, events, remote } = realFixture(remoteMode);
      await manager["startIproxyTunnel"]();
      manager["xcTestProcessId"] = 456;
      keep(
        spyOn(PortManager, "release").mockImplementation(() => {
          expect(client.localPort).toBeNull();
          expect(client.devicePort).toBeNull();
          events.push("release-port");
        }),
      );
      keep(
        spyOn(manager, "isRunnerStillOwnedWithinShutdownDeadline").mockImplementation(async () => {
          events.push("runner-ownership");
          return false;
        }),
      );
      remote.stopIproxy = async () => {
        events.push("remote-stop:123");
        return { success: false, error: "already stopped" };
      };
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      keep(warning);
      events.length = 0;
      const stopping = manager["forceStopForShutdown"](5000);
      expect(events).toEqual(
        remoteMode
          ? ["unsupervise", "release-port", "runner-stop", "remote-stop:123"]
          : ["unsupervise", "release-port", "kill:SIGKILL", "runner-ownership"],
      );
      await stopping;
      expect(
        warning.mock.calls.some(([line]) => String(line).includes("Failed to stop host iproxy")),
      ).toBe(false);
      if (!remoteMode) {
        expect(children[0].killed).toBe(true);
      }
    },
  );
  test("simulator supervised probe returns before detection and disconnect uses manager identity before start", async () => {
    const { manager, supervisor, events } = realFixture();
    const detection = spyOn(manager, "isDeviceDetected").mockResolvedValue(false);
    keep(detection);
    const simulator = spyOn(manager, "isSimulator").mockReturnValue(true);
    keep(simulator);
    expect(await supervisor.isAlive()).toBe(true);
    expect(detection).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    simulator.mockReturnValue(false);
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    keep(warning);
    expect(await supervisor.isAlive()).toBe(true);
    expect(warning).toHaveBeenCalledWith(
      `[IOSCtrlProxy] Device ${device.deviceId} not detected, stopping iproxy monitoring`,
    );
    expect(events).toEqual(["unsupervise"]);
  });
});
