import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  DefaultIosTunnelClient,
  type RemoteIosTunnelRunner,
} from "../../src/ctrlProxy/ios/IosTunnelClient";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { IosCtrlProxyProcessClient } from "../../src/ctrlProxy/ios/IosCtrlProxyProcessClient";
import { ActionableError } from "../../src/models/ActionableError";
import { logger } from "../../src/utils/logger";
import { PortManager } from "../../src/utils/PortManager";
import { FakeIosTunnelClient } from "../fakes/FakeIosTunnelClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeChildProcess } from "../fakes/FakeChildProcess";

const request = { localPort: 8765, devicePort: 9100, udid: "usb-device" };
const timers: FakeTimer[] = [];
afterEach(() => {
  for (const timer of timers.splice(0)) {
    timer.reset();
  }
  PortManager.reset();
});
async function flush(): Promise<void> {
  for (let turn = 0; turn < 40; turn++) {
    await Promise.resolve();
  }
}

function fixture(remoteMode = false) {
  const timer = new FakeTimer();
  timers.push(timer);
  function fakeChild(): FakeChildProcess {
    const process = new FakeChildProcess(timer);
    process.simulateSpawn = () => {};
    process.kill = () => {
      process.killed = true;
      process.exitCode = 0;
      process.emit("exit", 0, null);
      return true;
    };
    return process;
  }
  const child = fakeChild();
  let firstSpawn = true;
  const executor = new (class extends FakeProcessExecutor {
    override spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess {
      this.setNextSpawnProcess(firstSpawn ? child : fakeChild());
      firstSpawn = false;
      return super.spawn(command, args, options);
    }
  })();
  const remote: RemoteIosTunnelRunner = {
    startIproxy: async () => ({ success: true, data: { pid: 123 } }),
    stopIproxy: async () => ({ success: true }),
    getIproxyStatus: async () => ({ success: true, data: { running: true } }),
  };
  const state = { connected: true, stopping: false, simulator: false, port: request.localPort };
  const processClient = new IosCtrlProxyProcessClient(executor, timer);
  const client = new DefaultIosTunnelClient({
    processExecutor: executor,
    timer,
    remoteRunner: remote,
    useRemoteRunner: () => remoteMode,
    isRunning: (pid) => processClient.isRunning(pid),
    isConnected: async () => state.connected,
    prepareRemoteStart: async () => {},
    getServicePort: () => state.port,
    getDeviceId: () => request.udid,
    isStopping: () => state.stopping,
    isSimulator: () => state.simulator,
    restart: () =>
      client.start({
        ...request,
        devicePort: client.devicePort ?? request.devicePort,
        supervise: false,
      }),
  });
  return { timer, executor, child, client, remote, state };
}

describe("IosTunnelClient", () => {
  test("argv-only local startup records only the host port; a live duplicate reuses its owned child", async () => {
    const { client, executor } = fixture();
    await client.start(request);
    await client.start(request);
    expect(executor.getSpawnedProcesses()).toHaveLength(1);
    expect(executor.getSpawnedProcesses()[0].args).toEqual(["8765", "8765", "usb-device"]);
    expect(client.localPort).toBe(8765);
    expect(client.devicePort).toBeNull();
    expect(await client.isAlive()).toBe(true);
  });

  test("moving the host port stops the old child before acquiring another", async () => {
    const { client, executor, child, state } = fixture();
    await client.start(request);
    state.port = 8766;
    await client.start({ ...request, localPort: 8766 });
    expect(child.killed).toBe(true);
    expect(client.localPort).toBe(8766);
    expect(executor.getSpawnedProcesses()).toHaveLength(2);
  });

  test.each([false, true])(
    "async spawn error with PID=%s reports its cause safely",
    async (hasPid) => {
      const { client, child, timer, executor } = fixture();
      if (!hasPid) {
        child.pid = undefined;
      } else {
        executor.setCommandHandler("kill -0", () => {
          throw new Error("not running");
        });
      }
      const failure = new Error("spawn iproxy ENOENT");
      const starting = client.start(request);
      await flush();
      expect(child.listenerCount("error")).toBeGreaterThan(0);
      // Emit only after spawn returned and startup installed its immediate listener.
      expect(() => child.emit("error", failure)).not.toThrow();
      await expect(starting).rejects.toEqual(
        new ActionableError("Failed to start iproxy tunnel: spawn iproxy ENOENT", {
          cause: failure,
        }),
      );
      expect(timer.getSleepHistory()).toEqual(hasPid ? [100] : [0]);
      expect(timer.getPendingIntervals()).toEqual([]);
      await expect(starting).rejects.toBeInstanceOf(ActionableError);
    },
  );

  test("a failed readiness probe keeps the child tracked and preserves the exact Error", async () => {
    const { client, executor, child, timer } = fixture();
    timer.enableAutoAdvance();
    executor.setCommandHandler("kill -0", () => {
      throw new Error("no process");
    });
    await expect(client.start(request)).rejects.toEqual(
      new Error("iproxy failed to stay running within 5000ms"),
    );
    expect(child.killed).toBe(false);
    expect(client.localPort).toBe(8765);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("child exit schedules a replacement at the same ports; stop cancels further restarts", async () => {
    const { client, child, timer, executor } = fixture();
    await client.start(request);
    child.emit("exit", 1, null);
    await flush();
    expect(timer.getPendingTimeouts()).toEqual([1000]);
    expect(client.localPort).toBeNull();
    timer.advanceTime(1000);
    await flush();
    expect(executor.getSpawnedProcesses()).toHaveLength(2);
    expect(client.devicePort).toBeNull();
    await client.stop({ clearDevicePort: true });
    timer.advanceTime(30000);
    await flush();
    expect(executor.getSpawnedProcesses()).toHaveLength(2);
    expect(client.devicePort).toBeNull();
  });

  test("restart failures back off with a bounded delay and remain cancellable", async () => {
    const { client, child, timer, executor } = fixture();
    await client.start(request);
    child.emit("exit", 1, null);
    await flush();
    const spawn = spyOn(executor, "spawn").mockImplementation(() => {
      throw new Error("binary missing");
    });
    try {
      for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
        expect(timer.getPendingTimeouts()).toEqual([delay]);
        timer.advanceTime(delay);
        await flush();
      }
      await client.stop();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      spawn.mockRestore();
    }
  });

  test("disconnect retires the child and monitoring without a replacement", async () => {
    const { client, child, timer, executor, state } = fixture();
    await client.start(request);
    state.connected = false;
    timer.advanceTime(5000);
    await flush();
    expect(child.killed).toBe(true);
    expect(timer.getPendingIntervals()).toHaveLength(0);
    expect(executor.getSpawnedProcesses()).toHaveLength(1);
  });

  test("stop during an in-flight remote readiness probe permits late supervision", async () => {
    const { client, remote, timer } = fixture(true);
    let entered!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    remote.getIproxyStatus = async () => {
      entered();
      await gate;
      return { success: true, data: { running: true } };
    };
    const stop = spyOn(remote, "stopIproxy");
    const starting = client.start(request);
    await entry;
    await client.stop();
    release();
    await starting;
    expect(timer.getPendingIntervals()).toHaveLength(1);
    expect(stop).toHaveBeenCalledWith({ pid: 123 });
    expect(client.localPort).toBeNull();
    stop.mockRestore();
  });

  test("remote launch reports the original port collision Error without transport fallback", async () => {
    const { client, remote, executor } = fixture(true);
    remote.startIproxy = async () => ({ success: false, error: "host port collision" });
    await expect(client.start(request)).rejects.toEqual(new Error("host port collision"));
    expect(client.localPort).toBeNull();
    expect(executor.getSpawnedProcesses()).toHaveLength(0);
  });

  test("graceful cleanup retains the old signal sequence and exit listeners", async () => {
    const { client, child, timer } = fixture();
    await client.start(request);
    timer.enableAutoAdvance();
    const signals: Array<NodeJS.Signals | number | undefined> = [];
    child.kill = (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") {
        child.exitCode = 1;
        child.emit("exit", 1, signal);
      }
      return true;
    };
    const before = child.listenerCount("error");
    await client.stop();
    expect(signals).toEqual([undefined, "SIGKILL"]);
    expect(child.listenerCount("error")).toBe(before + 1);
    expect(client.localPort).toBeNull();
  });

  test("logs retain the old lifecycle line and bounded output", async () => {
    const { client, child } = fixture();
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await client.start(request);
      child.stderr.emit("data", "  " + "x".repeat(700) + "  ");
      expect(info.mock.calls).toEqual([
        ["[IOSCtrlProxy] Starting iproxy tunnel (localhost:8765 -> device:8765)"],
      ]);
      expect(warn.mock.calls.some(([line]) => line === "[iproxy stderr] " + "x".repeat(500))).toBe(
        true,
      );
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  test("manager uses an injected typed fake without owning process state", async () => {
    const { timer, executor } = fixture();
    const fake = new FakeIosTunnelClient();
    const manager = IOSCtrlProxyManager.createForTesting(
      { deviceId: request.udid, platform: "ios", name: "iPhone" },
      timer,
      undefined,
      fake,
    );
    await manager["startIproxyTunnel"]();
    expect(fake.starts[0].localPort).toBe(manager.getServicePort());
    await manager["stopIproxyTunnel"]({ clearDevicePort: true });
    expect(await fake.isAlive()).toBe(false);
    expect(executor.getSpawnedProcesses()).toHaveLength(0);
    expect(Object.values(manager)).toContain(fake);
    expect(fake.starts).toEqual([
      {
        localPort: manager.getServicePort(),
        devicePort: manager.getServicePort(),
        udid: request.udid,
      },
    ]);
  });
});
