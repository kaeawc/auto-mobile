import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { ActionableError, type DeviceInfo } from "../../../src/models";
import { setDeviceManager } from "../../../src/server/bootedDeviceResources";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import { clearDirectSessionDevices } from "../../../src/utils/directSessionDeviceRegistry";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { SessionToolBindingStore } from "../../../src/server/sessionToolBindingStore";
import {
  HeartbeatTaskLeaseKeepalive,
  type TaskLeaseHoldRequest,
} from "../../../src/daemon/tasks/taskLeaseKeepalive";
import { TASK_ELIGIBILITY } from "../../../src/server/tasks/toolCallTasks";
import { resetVideoRecordingManagerDependencies } from "../../../src/daemon/videoRecordingManager";
import { DefaultDeviceMatcher } from "../../../src/utils/deviceMatcher";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { resetProvisionedDeviceTransportFenceForTests } from "../../../src/utils/provisionedDeviceTransportFence";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTaskManager } from "../../fakes/FakeTaskManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { connect, type Frame } from "../../helpers/mcpTaskWire";
import { RealBootGatesOverFakeFleet } from "../../helpers/realBootGatesOverFakeFleet";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";

isolateToolRegistry();

/*
 * startDevice as an MCP task (#4668, owner decision 2026-10-18), end to end through the real
 * startDevice handler over a fake fleet: each request gets its own stateless server under one
 * session key, as the daemon's HTTP endpoint builds them.
 */

const AVD_SERIAL = "emulator-5554";
const avd: DeviceInfo = {
  name: "Pixel_7_API_34",
  platform: "android",
  deviceId: AVD_SERIAL,
  isRunning: false,
  source: "local",
  osVersion: "14",
  formFactor: "phone",
};
const START = { platform: "android", name: avd.name };
const KEY = "key-start";
const PROBE = "__task_device_probe__";

/** The cold boot's emulator process: killing it is what stops the booted device. */
class BootHandle extends FakeChildProcess {
  constructor(
    timer: FakeTimer,
    private readonly onKill: () => void,
  ) {
    super(timer);
  }

  override kill(signal?: NodeJS.Signals | number): boolean {
    this.onKill();
    return super.kill(signal);
  }
}

describe("startDevice as an MCP task (#4668)", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let devices: FakeDeviceUtils;
  let pool: DevicePool;
  let bootHandle: BootHandle;
  let bindings: SessionToolBindingStore;
  let taskManager: FakeTaskManager;
  let keepalive: HeartbeatTaskLeaseKeepalive;
  let holds: TaskLeaseHoldRequest[];
  let scope: number;
  /** Runner readiness (the last step before the bind) waits on this while it is set. */
  let runnerGate: Promise<void> | undefined;
  let runnerReached: (() => void) | undefined;
  let probedSessions: unknown[];
  let restorePipeline: () => void;

  function arrange(): void {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    clearDirectSessionDevices();
    resetProvisionedDeviceTransportFenceForTests();
    runnerGate = undefined;
    runnerReached = undefined;
    scope = 0;
    holds = [];
    timer = new FakeTimer();
    devices = new FakeDeviceUtils();
    devices.setBootedDevices("android", []);
    devices.setBootedDevices("ios", []);
    devices.setDeviceImages("android", [avd]);
    bootHandle = new BootHandle(timer, () => devices.setBootedDevices("android", []));
    devices.setMockChildProcess(avd.name, bootHandle);
    new RealBootGatesOverFakeFleet(devices, timer, 1);
    const idGenerator = new CountingIdGenerator("start-task");
    const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
    setDeviceToolsDependencies({
      env,
      deviceManagerFactory: () => devices,
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      clearInstalledAppsForDevice: async () => {},
      ensureCtrlProxyReady: async (request) => {
        runnerReached?.();
        if (runnerGate) {
          await Promise.race([
            runnerGate,
            new Promise<never>((_resolve, reject) => {
              request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
                once: true,
              });
            }),
          ]);
        }
      },
      timer,
      idGenerator,
    });
    PlatformDeviceManagerFactory.setInstance(devices);
    setDeviceManager(devices);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "start-task-daemon", {
        env,
        timer,
        idGenerator,
        deviceManager: devices,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceSessionRepository: { markAutolockSession: async () => {} },
      }),
    );
    DaemonState.getInstance().initialize(
      sessions,
      pool,
      new DeviceSessionRegistry(timer, idGenerator),
    );
    registerDeviceTools();
    probedSessions = [];
    ToolRegistry.registerDeviceAware(PROBE, "probe", z.object({}), async () => ({
      content: [{ type: "text", text: "probed" }],
    }));
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      // Records the session a device tool's call was routed to, short of touching a device.
      executionTargetResolver: {
        resolveExecutionTarget: async (input) => {
          probedSessions.push(input.args.sessionUuid);
          throw new ActionableError("probe stops before the device");
        },
      },
    });

    bindings = new SessionToolBindingStore();
    taskManager = new FakeTaskManager({ timer });
    keepalive = new HeartbeatTaskLeaseKeepalive({ sessions: () => sessions, timer });
    const hold = keepalive.hold.bind(keepalive);
    keepalive.hold = (request) => {
      holds.push(request);
      return hold(request);
    };
  }

  function teardown(): void {
    restorePipeline();
    keepalive.releaseAll();
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    sessions.stopCleanupTimer();
    clearDirectSessionDevices();
    resetProvisionedDeviceTransportFenceForTests();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.reset();
    resetVideoRecordingManagerDependencies();
    timer.reset();
  }

  /** One POST's server: a one-off request scope under the caller's session key. */
  const request = () =>
    connect({
      daemonMode: true,
      stateless: true,
      requestMcpSessionId: KEY,
      sessionContext: { sessionId: `scope-${++scope}` },
      sessionToolBindingStore: bindings,
      taskManager,
      taskLeaseKeepalive: keepalive,
    });

  const spin = async (turns = 50): Promise<void> => {
    for (let turn = 0; turn < turns; turn++) {
      await Promise.resolve();
    }
  };

  /** Between polls the fake clock moves, so boot polling and grace timers can fire. */
  const tick = async (): Promise<void> => {
    await spin();
    timer.advanceTime(250);
    await new Promise((resolve) => setImmediate(resolve));
  };

  /** One call on its own request server, closed once answered (the endpoint's close). */
  async function post(
    method: "tools/call" | "tasks/get" | "tasks/cancel",
    declared: boolean,
    params: Record<string, unknown>,
  ): Promise<Frame> {
    const server = await request();
    try {
      if (method === "tools/call") {
        return await server.wire.call(
          String(params.name),
          params.arguments as Record<string, unknown>,
          declared,
        );
      }
      return await server.wire.task(method, String(params.taskId));
    } finally {
      await server.close();
    }
  }

  async function settled(taskId: string): Promise<Frame> {
    const server = await request();
    try {
      return await server.wire.settled(taskId, tick);
    } finally {
      await server.close();
    }
  }

  const payloadOf = (result: Frame) => JSON.parse(result.content[0].text);

  /** A synchronous startDevice on its own request server, ticking the fake clock meanwhile. */
  async function startSynchronously(): Promise<Frame | undefined> {
    const server = await request();
    try {
      let frame: Frame | undefined;
      void server.wire.call("startDevice", START, false).then((value) => (frame = value));
      for (let turn = 0; turn < 200 && !frame; turn++) {
        await tick();
      }
      return frame;
    } finally {
      await server.close();
    }
  }

  // The first boot through the handler loads and compiles the whole acquisition path; pay that
  // once here rather than inside a test's 100 ms budget.
  beforeAll(async () => {
    arrange();
    try {
      await startSynchronously();
    } finally {
      teardown();
    }
  });
  // Builds the DevicePool harness inside each test, so its cost is paid honestly in the test body.
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrange();
        await fn();
      },
      timeout,
    );
  }
  afterEach(teardown);

  arranged("a non-declaring call gets the synchronous startDevice result and no task", async () => {
    const frame = await startSynchronously();
    expect(frame?.result.resultType).toBeUndefined();
    expect(frame?.result.isError).not.toBe(true);
    expect(payloadOf(frame!.result)).toMatchObject({ isReady: true });
    expect(taskManager.calls).toEqual([]);
    expect(holds).toEqual([]);
    const { sessionUuid } = payloadOf(frame!.result).runtime.session;
    // Nothing heartbeated for the caller: a synchronous caller heartbeats its own session.
    expect(sessions.peekSession(sessionUuid)?.hasReceivedHeartbeat).toBe(false);
  });

  arranged("startDevice is an eligible tool", () => {
    expect(TASK_ELIGIBILITY({ name: "startDevice", args: {} })).toEqual({ onCancel: "abort" });
    expect(TASK_ELIGIBILITY({ name: "installApp", args: {} })).toEqual({ onCancel: "abort" });
  });

  arranged(
    "a declaring call gets a task that completes with the startDevice result, holding the bound session until then",
    async () => {
      const created = await post("tools/call", true, { name: "startDevice", arguments: START });
      expect(created.result).toMatchObject({ resultType: "task", status: "working" });
      const taskId = created.result.taskId as string;

      const done = await settled(taskId);
      expect(done.result).toMatchObject({ resultType: "complete", status: "completed" });
      const payload = payloadOf(done.result.result);
      expect(payload).toMatchObject({ isReady: true });
      const { sessionUuid } = payload.runtime.session;
      expect(typeof sessionUuid).toBe("string");

      // The task held the session it bound and let it go once it settled.
      expect(holds).toEqual([{ taskId, ownerKey: KEY, sessionUuid }]);
      expect(keepalive.heldCount).toBe(0);
      // The binding outlives the request servers: the key still routes to the bound device.
      expect(bindings.boundSessionUuid(KEY)).toBe(sessionUuid);
      expect(pool.getDevice(AVD_SERIAL)).toMatchObject({ status: "busy", sessionId: sessionUuid });
      // The hold renewed the owner lease through the session manager's heartbeat.
      expect(sessions.peekSession(sessionUuid)).toMatchObject({
        assignedDevice: AVD_SERIAL,
        hasReceivedHeartbeat: true,
      });

      // A later call on a fresh request server under the same key reaches that device.
      await post("tools/call", false, { name: PROBE, arguments: {} });
      expect(probedSessions).toEqual([sessionUuid]);
    },
  );

  arranged("tasks/cancel during the boot stops it and leaves nothing bound", async () => {
    let release!: () => void;
    runnerGate = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (runnerReached = resolve));
    const created = await post("tools/call", true, { name: "startDevice", arguments: START });
    const taskId = created.result.taskId as string;
    for (let turn = 0; turn < 200; turn++) {
      const done = await Promise.race([reached.then(() => true), tick().then(() => false)]);
      if (done) {
        break;
      }
    }
    expect((await post("tasks/get", true, { taskId })).result.status).toBe("working");

    const ack = await post("tasks/cancel", true, { taskId });
    expect(ack.result).toEqual({ resultType: "complete" });
    const done = await settled(taskId);
    release();
    for (let second = 0; second < 10; second++) {
      await tick();
    }

    expect(done.result.status).toBe("cancelled");
    expect(holds).toEqual([]);
    expect(sessions.getAllSessions()).toEqual([]);
    expect(pool.getDevice(AVD_SERIAL)?.sessionId ?? null).toBeNull();
    expect(bindings.boundSessionUuid(KEY)).toBeUndefined();
    expect(bootHandle.killed).toBe(true);
  });
});
