import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "node:events";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { executionTracker } from "../../src/server/executionTracker";
import { createSetActiveDeviceHandler } from "../../src/server/setActiveDevice";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { ExactProvisionedDevice } from "../../src/devices/exactDeviceProvisioning";
import {
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
} from "../../src/devices/virtualDeviceLifecycleCoordinator";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { clearDirectSessionDevices } from "../../src/server/directSessionDeviceRegistry";
import { setDeviceManager } from "../../src/server/bootedDeviceResources";
import { combineRequestAbortSignals } from "../../src/utils/AbortContext";
import { DefaultDeviceMatcher } from "../../src/utils/deviceMatcher";
import { classifyDisplayCutout } from "../../src/utils/displayCutout";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { resetProvisionedDeviceTransportFenceForTests } from "../../src/utils/provisionedDeviceTransportFence";
import { FakeDeviceCreationGate } from "../fakes/FakeDeviceCreationGate";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

isolateToolRegistry();

// #11593: an acquisition whose request was aborted before its result was handed back is undone.
// The session it minted is released, its cross-daemon claim withdrawn, a session it moved is moved
// back, and the device it booted is stopped on either platform; a device that was already running
// stays running. The table runs every acquiring tool through its real handler and cancels the
// request before the bind, while the bind publishes its claim, and after the bind returned.

const SIM_UDID = "AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA";
const OTHER_SIM_UDID = "BBBBBBBB-2222-4222-8222-BBBBBBBBBBBB";
const simulator: DeviceInfo = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: SIM_UDID,
  isRunning: false,
  source: "local",
  osVersion: "18.2",
  iosVersion: "18.2",
  formFactor: "phone",
};
const otherSimulator: DeviceInfo = {
  ...simulator,
  name: "iPhone 16 Pro",
  deviceId: OTHER_SIM_UDID,
};
const bootedSimulator: BootedDevice = { name: simulator.name, platform: "ios", deviceId: SIM_UDID };
const otherBootedSimulator: BootedDevice = {
  name: otherSimulator.name,
  platform: "ios",
  deviceId: OTHER_SIM_UDID,
};
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
const bootedAvd: BootedDevice = { name: avd.name, platform: "android", deviceId: AVD_SERIAL };
const ANDROID_SPEC = {
  runtime: "system-images;android-34;google_apis;x86_64",
  deviceType: "pixel_7",
};

/** The boot's process handle: `kill` is what stops the cold-booted device. */
class RecordingBootHandle extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | null = null;
  readonly signalCode: NodeJS.Signals | null = null;
  killed = false;

  /** A stopped device is no longer listed as booted. */
  constructor(private readonly onKill: () => void) {
    super();
  }

  kill(): boolean {
    this.killed = true;
    this.onKill();
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

/** Claims publish at once unless the test gates them to cancel while one is in flight. */
class ClaimOwnership implements ForeignDeviceOwnership {
  gated = false;
  readonly pending: Array<() => void> = [];
  readonly held = new Set<string>();

  async refresh(): Promise<void> {}

  foreignOwnerPid(): number | undefined {
    return undefined;
  }

  claim(deviceId: string): Promise<boolean> {
    if (!this.gated) {
      this.held.add(deviceId);
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      this.pending.push(() => {
        this.held.add(deviceId);
        resolve(true);
      });
    });
  }

  release(deviceId: string): void {
    this.held.delete(deviceId);
  }
}

/** The real coordinator, reporting each lease release: the acquiring tools' last awaited step. */
function coordinatorReportingReleases(
  timer: FakeTimer,
  held: Set<object>,
  onRelease: () => void,
): VirtualDeviceLifecycleCoordinator {
  const real = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
  return {
    isReserved: (identity) => real.isReserved(identity),
    reserve: async (identity, options) => {
      const lease = await real.reserve(identity, options);
      held.add(lease);
      return {
        get signal() {
          return lease.signal;
        },
        get identity() {
          return lease.identity;
        },
        bindCanonicalIdentity: (canonical, revalidate) =>
          lease.bindCanonicalIdentity(canonical, revalidate),
        transitionToTeardown: () => lease.transitionToTeardown(),
        markHeldByUnkillableProcess: (pid) => lease.markHeldByUnkillableProcess?.(pid),
        release: () => {
          lease.release();
          held.delete(lease);
          onRelease();
        },
      };
    },
  };
}

type CancelPoint = "before the bind" | "while the bind publishes its claim" | "after the bind";
const CANCEL_POINTS: CancelPoint[] = [
  "before the bind",
  "while the bind publishes its claim",
  "after the bind",
];
type DeviceOrigin = "already running" | "booted by this call";
const DEVICE_ORIGINS: DeviceOrigin[] = ["already running", "booted by this call"];

const ACQUIRING_TOOLS = [
  { tool: "getAndroid", args: { avdName: avd.name }, deviceId: AVD_SERIAL },
  { tool: "getApple", args: { udid: SIM_UDID }, deviceId: SIM_UDID },
  { tool: "startDevice", args: { platform: "android", name: avd.name }, deviceId: AVD_SERIAL },
  { tool: "startDevice", args: { platform: "ios", deviceId: SIM_UDID }, deviceId: SIM_UDID },
  {
    tool: "provisionDevice",
    args: {
      device: { platform: "android", name: avd.name, spec: ANDROID_SPEC },
      boot: true,
      readiness: "automation",
    },
    deviceId: AVD_SERIAL,
  },
] as const;

describe.each([
  ["autolock off", "0"],
  ["autolock on", "1"],
])("an acquisition cancelled before its result is delivered (%s)", (_, autolock) => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let devices: FakeDeviceUtils;
  let pool: DevicePool;
  let ownership: ClaimOwnership;
  let bootHandle: RecordingBootHandle;
  /** Device lifecycle leases reserved and not yet released. */
  let heldLeases: Set<object>;
  /** Runs where the request is to be cancelled; each hook is cleared once it fires. */
  let beforeBind: (() => void) | undefined;
  let afterBind: (() => void) | undefined;

  beforeEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    clearDirectSessionDevices();
    resetProvisionedDeviceTransportFenceForTests();
    beforeBind = undefined;
    afterBind = undefined;
    heldLeases = new Set();
    timer = new FakeTimer();
    devices = new FakeDeviceUtils();
    devices.setBootedDevices("android", []);
    devices.setBootedDevices("ios", []);
    devices.setDeviceImages("android", [avd]);
    devices.setDeviceImages("ios", [simulator, otherSimulator]);
    bootHandle = new RecordingBootHandle(() => {
      devices.setBootedDevices("android", []);
      devices.setBootedDevices("ios", []);
    });
    devices.setMockChildProcess(avd.name, bootHandle as unknown as ChildProcess);
    devices.setMockChildProcess(simulator.name, bootHandle as unknown as ChildProcess);
    ownership = new ClaimOwnership();
    const idGenerator = new CountingIdGenerator("undelivered");
    const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: autolock };
    const provisioned: ExactProvisionedDevice = {
      created: false,
      device: { name: avd.name, platform: "android", isRunning: false, ...ANDROID_SPEC },
      resolvedSpec: {
        ...ANDROID_SPEC,
        displayCutout: classifyDisplayCutout("android", ANDROID_SPEC.deviceType),
      },
    };
    setDeviceToolsDependencies({
      env,
      deviceManagerFactory: () => devices,
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
      exactDeviceProvisionerFactory: () => ({ provision: async () => provisioned }),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      clearInstalledAppsForDevice: async () => {},
      // Runner readiness is the last step before the bind.
      ensureCtrlProxyReady: async () => {
        const cancel = beforeBind;
        beforeBind = undefined;
        cancel?.();
      },
      // The device's lifecycle lease is released once the bind has returned and published its
      // claim: the last thing an acquiring handler does before it answers.
      lifecycleCoordinator: coordinatorReportingReleases(timer, heldLeases, () => {
        if (ownership.held.size > 0) {
          const cancel = afterBind;
          afterBind = undefined;
          cancel?.();
        }
      }),
      timer,
      idGenerator,
    });
    PlatformDeviceManagerFactory.setInstance(devices);
    setDeviceManager(devices);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "undelivered-daemon", {
        env,
        timer,
        idGenerator,
        deviceManager: devices,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceSessionRepository: { markAutolockSession: async () => {} },
        foreignDeviceOwnership: ownership,
        iosForeignDeviceOwnership: ownership,
      }),
    );
    DaemonState.getInstance().initialize(
      sessions,
      pool,
      new DeviceSessionRegistry(timer, idGenerator),
    );
    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    sessions.stopCleanupTimer();
    clearDirectSessionDevices();
    resetProvisionedDeviceTransportFenceForTests();
    setDeviceManager(null);
    PlatformDeviceManagerFactory.reset();
    resetVideoRecordingManagerDependencies();
    timer.reset();
  });

  const spin = async (turns = 200): Promise<void> => {
    for (let turn = 0; turn < turns; turn++) {
      await Promise.resolve();
    }
  };

  /** Give every deferred cancellation settlement and grace timer room to run. */
  const drain = async (): Promise<void> => {
    for (let second = 0; second < 10; second++) {
      await spin();
      timer.advanceTime(1_000);
    }
    await spin();
  };

  /** The session id a tool call handed its caller, or undefined when the call was refused. */
  const deliveredSession = async (
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    try {
      const response = (await ToolRegistry.getTool(tool)!.handler(
        { ...args, __mcpSessionId: "mcp-client" },
        undefined,
        signal,
      )) as { content: Array<{ text: string }> };
      const payload = JSON.parse(response.content[0].text) as {
        sessionId?: string;
        runtime?: { session?: { sessionUuid?: string } };
      };
      return payload.runtime?.session?.sessionUuid ?? payload.sessionId;
    } catch {
      return undefined;
    }
  };

  /** Arrange for `cancel` to run at `point` of the next acquisition. */
  const cancelAt = (point: CancelPoint, cancel: () => void): (() => Promise<void>) => {
    if (point === "before the bind") {
      beforeBind = cancel;
      return async () => {};
    }
    if (point === "after the bind") {
      afterBind = cancel;
      return async () => {};
    }
    ownership.gated = true;
    return async () => {
      for (let turn = 0; turn < 5_000 && ownership.pending.length === 0; turn++) {
        await Promise.resolve();
      }
      expect(ownership.pending.length).toBe(1);
      cancel();
      await spin();
      ownership.gated = false;
      ownership.pending[0]();
    };
  };

  const startRunning = async (...booted: BootedDevice[]): Promise<void> => {
    for (const platform of ["android", "ios"] as const) {
      devices.setBootedDevices(
        platform,
        booted.filter((device) => device.platform === platform),
      );
    }
    await pool.initializeWithDevices(booted);
  };

  const cases = ACQUIRING_TOOLS.flatMap((acquiring) =>
    CANCEL_POINTS.flatMap((point) =>
      DEVICE_ORIGINS.map((origin) => ({ ...acquiring, point, origin })),
    ),
  );

  test.each(cases)(
    "$tool $args cancelled $point, device $origin: nothing stays bound and only this call's boot is stopped",
    async ({ tool, args, deviceId, point, origin }) => {
      if (origin === "already running") {
        await startRunning(deviceId === AVD_SERIAL ? bootedAvd : bootedSimulator);
      }
      const controller = new AbortController();
      let cancelled = false;
      const reachCancelPoint = cancelAt(point, () => {
        cancelled = true;
        controller.abort(new Error("client cancelled"));
      });

      const delivered = deliveredSession(tool, args, controller.signal);
      await reachCancelPoint();
      const sessionUuid = await delivered;
      await drain();

      expect(cancelled).toBe(true);
      expect(sessionUuid).toBeUndefined();
      expect(sessions.getAllSessions()).toEqual([]);
      expect(pool.getDevice(deviceId)?.sessionId ?? null).toBeNull();
      expect([...ownership.held]).toEqual([]);
      expect(heldLeases.size).toBe(0);
      if (origin === "already running") {
        expect(bootHandle.killed).toBe(false);
        expect(devices.wasMethodCalled("killDevice")).toBe(false);
        expect(pool.getDevice(deviceId)?.status).toBe("idle");
      } else {
        expect(bootHandle.killed).toBe(true);
      }
    },
  );

  test.each(ACQUIRING_TOOLS)(
    "control: an uncancelled $tool $args keeps its session, its claim and the device it booted",
    async ({ tool, args, deviceId }) => {
      const sessionUuid = await deliveredSession(tool, args, new AbortController().signal);
      await drain();

      expect(sessionUuid).toBeTruthy();
      expect(pool.getDevice(deviceId)?.sessionId).toBe(sessionUuid!);
      expect([...ownership.held]).toEqual([deviceId]);
      expect(bootHandle.killed).toBe(false);
    },
  );

  test("an abort the daemon raised itself still delivers the result and undoes nothing", async () => {
    await startRunning(bootedSimulator);
    const daemonSide = new AbortController();
    const signal = combineRequestAbortSignals(daemonSide.signal, new AbortController().signal);
    afterBind = () => daemonSide.abort(new Error("device lost"));

    const sessionUuid = await deliveredSession("getApple", { udid: SIM_UDID }, signal);
    await drain();

    expect(signal?.aborted).toBe(true);
    expect(sessionUuid).toBeTruthy();
    expect(pool.getDevice(SIM_UDID)?.sessionId).toBe(sessionUuid!);
    expect([...ownership.held]).toEqual([SIM_UDID]);
  });

  test("a session another call is already driving is not released under it", async () => {
    await startRunning(bootedSimulator);
    const controller = new AbortController();
    let sibling: { id: string } | undefined;
    afterBind = () => {
      // The minted session is routable before the acquiring call answers; a sibling call uses it.
      sibling = executionTracker.startExecution(
        "tapOn",
        undefined,
        pool.getDevice(SIM_UDID)!.sessionId!,
      );
      controller.abort(new Error("client cancelled"));
    };

    const sessionUuid = await deliveredSession("getApple", { udid: SIM_UDID }, controller.signal);
    await drain();
    executionTracker.endExecution(sibling!.id);

    expect(sessionUuid).toBeUndefined();
    const held = pool.getDevice(SIM_UDID)!.sessionId!;
    expect(sessions.getSession(held)?.assignedDevice).toBe(SIM_UDID);
    expect([...ownership.held]).toEqual([SIM_UDID]);
  });

  test("a session its client reached through another call is not released", async () => {
    await startRunning(bootedSimulator);
    const controller = new AbortController();
    afterBind = () => {
      // A sibling acquisition on the connection reused the minted session and returned it, so
      // its keeper heartbeats the id the cancelled call never delivered.
      sessions.recordHeartbeat(pool.getDevice(SIM_UDID)!.sessionId!);
      controller.abort(new Error("client cancelled"));
    };

    const sessionUuid = await deliveredSession("getApple", { udid: SIM_UDID }, controller.signal);
    await drain();

    expect(sessionUuid).toBeUndefined();
    const held = pool.getDevice(SIM_UDID)!.sessionId!;
    expect(sessions.getSession(held)).toMatchObject({
      assignedDevice: SIM_UDID,
      hasReceivedHeartbeat: true,
    });
    expect([...ownership.held]).toEqual([SIM_UDID]);
  });

  test.each(CANCEL_POINTS)(
    "provisionDevice cancelled %s reports that it leaves no device of its own behind",
    async (point) => {
      const controller = new AbortController();
      const reachCancelPoint = cancelAt(point, () =>
        controller.abort(new Error("client cancelled")),
      );
      const response = ToolRegistry.getTool("provisionDevice")!.handler(
        {
          device: { platform: "android", name: avd.name, spec: ANDROID_SPEC },
          boot: true,
          readiness: "automation",
          __mcpSessionId: "mcp-client",
        },
        undefined,
        controller.signal,
      ) as Promise<{ content: Array<{ text: string }> }>;
      await reachCancelPoint();
      const payload = JSON.parse((await response).content[0].text) as {
        error: { code: string };
        recovery: { phaseReached: string; device?: object; outcomes: object; cleanup?: object };
      };
      await drain();

      // The adopted AVD's emulator, booted by this call, is stopped: the evidence names no
      // running device and no cleanup this request still owes.
      expect(bootHandle.killed).toBe(true);
      expect(payload.error.code).toBe("request_cancelled");
      expect(payload.recovery).toMatchObject({
        boundary: "caller_cancellation",
        phaseReached: "provisioning",
        outcomes: { deviceCreation: "not_created", settlement: "settled" },
        cleanup: { status: "unnecessary" },
      });
      expect(payload.recovery.device).toBeUndefined();
    },
  );

  describe("a device the cancelled call created", () => {
    const created = {
      platform: "android" as const,
      name: "AutoMobile-android-34-abcd1234",
      deviceType: "system-images;android-34;google_apis;arm64-v8a",
      runtime: "android-34",
    };

    /** Teardown dependencies the rollback reaches; without them it falls through to real I/O. */
    const useFakeTeardown = async (): Promise<void> => {
      await setVideoRecordingManagerDependencies({
        videoRecorderService: { listActiveRecordingIds: () => [] } as never,
        recordingRepository: new FakeVideoRecordingRepository() as never,
        configRepository: {} as never,
        highlightClient: {} as never,
        timer,
        now: () => new Date(0),
      });
      const killDevice = devices.killDevice.bind(devices);
      devices.killDevice = async (device) => {
        await killDevice(device);
        devices.setBootedDevices("android", []);
      };
    };

    test("startDevice createIfMissing cancelled after the bind deletes the AVD it created", async () => {
      devices.setDeviceImages("android", []);
      devices.setMockChildProcess(created.name, bootHandle as unknown as ChildProcess);
      setDeviceToolsDependencies({
        deviceCreationGateFactory: () => new FakeDeviceCreationGate(true),
        deviceProvisionerFactory: () => ({
          provision: async (_criteria, _signal, identityHooks) => {
            await identityHooks?.reserveBeforeCreate(created);
            devices.setDeviceImages("android", [
              { name: created.name, platform: "android", isRunning: false },
            ]);
            await identityHooks?.bindAfterCreate(created);
            return created;
          },
        }),
      });
      await useFakeTeardown();
      const controller = new AbortController();
      afterBind = () => controller.abort(new Error("client cancelled"));

      const pendingSession = deliveredSession(
        "startDevice",
        { platform: "android", createIfMissing: true },
        controller.signal,
      );
      await drain();
      const sessionUuid = await pendingSession;
      await drain();

      expect(sessionUuid).toBeUndefined();
      expect(sessions.getAllSessions()).toEqual([]);
      expect([...ownership.held]).toEqual([]);
      expect(bootHandle.killed).toBe(true);
      expect(
        devices
          .getExecutedOperations()
          .filter((operation) => operation.startsWith("destroyDevice:")),
      ).toHaveLength(1);
      expect(await devices.listDeviceImages("android")).toEqual([]);
      expect(heldLeases.size).toBe(0);
    });

    test("provisionDevice cancelled after the bind deletes the AVD it created and reports it", async () => {
      setDeviceToolsDependencies({
        exactDeviceProvisionerFactory: () => ({
          provision: async () => ({
            created: true,
            device: { name: avd.name, platform: "android", isRunning: false, ...ANDROID_SPEC },
            resolvedSpec: {
              ...ANDROID_SPEC,
              displayCutout: classifyDisplayCutout("android", ANDROID_SPEC.deviceType),
            },
          }),
        }),
      });
      await useFakeTeardown();
      const controller = new AbortController();
      afterBind = () => controller.abort(new Error("client cancelled"));

      const response = (await ToolRegistry.getTool("provisionDevice")!.handler(
        {
          device: { platform: "android", name: avd.name, spec: ANDROID_SPEC },
          boot: true,
          readiness: "automation",
          __mcpSessionId: "mcp-client",
        },
        undefined,
        controller.signal,
      )) as { isError?: boolean; content: Array<{ text: string }> };
      await drain();

      expect(response.isError).toBe(true);
      expect(JSON.parse(response.content[0].text)).toMatchObject({
        error: { code: "request_cancelled" },
      });
      expect(sessions.getAllSessions()).toEqual([]);
      expect([...ownership.held]).toEqual([]);
      expect(
        devices
          .getExecutedOperations()
          .filter((operation) => operation.startsWith("destroyDevice:")),
      ).toHaveLength(1);
      expect(heldLeases.size).toBe(0);
    });
  });

  describe("setActiveDevice", () => {
    const resumed: string[] = [];
    const setActiveDevice = (args: Record<string, unknown>, signal: AbortSignal) =>
      createSetActiveDeviceHandler({
        resumeCtrlProxy: async (deviceId) => {
          resumed.push(deviceId);
          const cancel = beforeBind;
          beforeBind = undefined;
          cancel?.();
        },
      })({ ...args, __mcpSessionId: "mcp-client" } as never, undefined, signal).then(
        () => true,
        () => false,
      );

    /** The rebind's last step: readiness is recorded once the pool has moved the session. */
    const cancelAfterRebind = (cancel: () => void): void => {
      const setDeviceReadiness = sessions.setDeviceReadiness.bind(sessions);
      sessions.setDeviceReadiness = (...readiness) => {
        setDeviceReadiness(...readiness);
        cancel();
      };
    };

    const cancelSelectionAt = (point: CancelPoint, cancel: () => void): (() => Promise<void>) => {
      if (point === "after the bind") {
        cancelAfterRebind(cancel);
        return async () => {};
      }
      return cancelAt(point, cancel);
    };

    test.each(CANCEL_POINTS)(
      "a rebind cancelled %s leaves the session on the device it held",
      async (point) => {
        await startRunning(bootedSimulator, otherBootedSimulator);
        const sessionUuid = await deliveredSession("getApple", { udid: SIM_UDID });
        expect(pool.getDevice(SIM_UDID)?.sessionId).toBe(sessionUuid!);
        sessions.setDisplayPin(sessionUuid!, "main");
        const controller = new AbortController();
        const reachCancelPoint = cancelSelectionAt(point, () =>
          controller.abort(new Error("client cancelled")),
        );

        const answered = setActiveDevice(
          { deviceId: OTHER_SIM_UDID, platform: "ios", sessionUuid },
          controller.signal,
        );
        await reachCancelPoint();
        expect(await answered).toBe(false);
        await drain();

        expect(sessions.getSession(sessionUuid!)?.assignedDevice).toBe(SIM_UDID);
        expect(pool.getDevice(SIM_UDID)).toMatchObject({ sessionId: sessionUuid, status: "busy" });
        expect(pool.getDevice(OTHER_SIM_UDID)).toMatchObject({ sessionId: null, status: "idle" });
        expect([...ownership.held]).toEqual([SIM_UDID]);
        expect(sessions.getDisplayPin(sessionUuid!)).toBe("main");
        expect(sessions.getAllSessions().map((session) => session.sessionId)).toEqual([
          sessionUuid!,
        ]);
      },
    );

    test.each(CANCEL_POINTS)(
      "a selection cancelled %s releases the session it minted",
      async (point) => {
        await startRunning(bootedSimulator);
        const controller = new AbortController();
        const reachCancelPoint = cancelSelectionAt(point, () =>
          controller.abort(new Error("client cancelled")),
        );

        const answered = setActiveDevice(
          { deviceId: SIM_UDID, platform: "ios", sessionUuid: "client-chosen-session" },
          controller.signal,
        );
        await reachCancelPoint();
        expect(await answered).toBe(false);
        await drain();

        expect(sessions.getAllSessions()).toEqual([]);
        expect(pool.getDevice(SIM_UDID)).toMatchObject({ sessionId: null, status: "idle" });
        expect([...ownership.held]).toEqual([]);
      },
    );

    test("the id a cancelled selection minted can be named again by its client", async () => {
      await startRunning(bootedSimulator);
      const controller = new AbortController();
      cancelAfterRebind(() => controller.abort(new Error("client cancelled")));
      const selection = {
        deviceId: SIM_UDID,
        platform: "ios",
        sessionUuid: "client-chosen-session",
      };

      expect(await setActiveDevice(selection, controller.signal)).toBe(false);
      await drain();
      // The client chose the id and retries with it after its own timeout.
      sessions.setDeviceReadiness = SessionManager.prototype.setDeviceReadiness.bind(sessions);
      const retried = await setActiveDevice(selection, new AbortController().signal);

      expect(retried).toBe(true);
      expect(sessions.getSession("client-chosen-session")?.assignedDevice).toBe(SIM_UDID);
      expect(pool.getDevice(SIM_UDID)).toMatchObject({ sessionId: "client-chosen-session" });
    });

    test("control: an uncancelled rebind moves the session and its claim", async () => {
      await startRunning(bootedSimulator, otherBootedSimulator);
      const sessionUuid = await deliveredSession("getApple", { udid: SIM_UDID });

      const answered = await setActiveDevice(
        { deviceId: OTHER_SIM_UDID, platform: "ios", sessionUuid },
        new AbortController().signal,
      );
      await drain();

      expect(answered).toBe(true);
      expect(sessions.getSession(sessionUuid!)?.assignedDevice).toBe(OTHER_SIM_UDID);
      expect(pool.getDevice(SIM_UDID)).toMatchObject({ sessionId: null, status: "idle" });
      expect([...ownership.held]).toEqual([OTHER_SIM_UDID]);
    });

    test("a cancelled rebind whose previous device was taken meanwhile stays whole on the new device", async () => {
      await startRunning(bootedSimulator, otherBootedSimulator);
      const sessionUuid = await deliveredSession("getApple", { udid: SIM_UDID });
      const controller = new AbortController();
      await sessions.createSession("other-session", SIM_UDID, "ios");
      cancelAfterRebind(() => {
        // Another session takes the freed device before the cancelled call can move back.
        const freed = pool.getDevice(SIM_UDID)!;
        freed.sessionId = "other-session";
        freed.status = "busy";
        controller.abort(new Error("client cancelled"));
      });

      const answered = await setActiveDevice(
        { deviceId: OTHER_SIM_UDID, platform: "ios", sessionUuid },
        controller.signal,
      );
      await drain();

      expect(answered).toBe(false);
      expect(sessions.getSession(sessionUuid!)?.assignedDevice).toBe(OTHER_SIM_UDID);
      expect(pool.getDevice(OTHER_SIM_UDID)).toMatchObject({ sessionId: sessionUuid });
      expect(pool.getDevice(SIM_UDID)?.sessionId).toBe("other-session");
    });
  });
});
