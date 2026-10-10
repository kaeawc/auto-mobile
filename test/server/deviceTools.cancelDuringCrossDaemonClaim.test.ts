import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "node:events";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { ExactProvisionedDevice } from "../../src/devices/exactDeviceProvisioning";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { clearDirectSessionDevices } from "../../src/server/directSessionDeviceRegistry";
import { setDeviceManager } from "../../src/server/bootedDeviceResources";
import { DefaultDeviceMatcher } from "../../src/utils/deviceMatcher";
import { classifyDisplayCutout } from "../../src/utils/displayCutout";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { resetProvisionedDeviceTransportFenceForTests } from "../../src/utils/provisionedDeviceTransportFence";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

isolateToolRegistry();

// #11565: the last awaited step of an acquisition's bind is the cross-daemon claim publish
// (`claimExplicitlyBoundDevice` -> `ForeignDeviceOwnership.claim`, file I/O that production wires
// for both platforms). It runs AFTER the session is committed. A request that is cancelled there is
// rejected at once (the bind is raced against the request signal), so the bind that then completes
// must be undone: the caller holds an error and no sessionUuid.

const SIM_UDID = "AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA";
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
const bootedSimulator: BootedDevice = { name: simulator.name, platform: "ios", deviceId: SIM_UDID };
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
const ANDROID_SPEC = {
  runtime: "system-images;android-34;google_apis;x86_64",
  deviceType: "pixel_7",
};

/** The boot's process handle: `kill` is what shuts the cold-booted device down. */
class RecordingBootHandle extends EventEmitter {
  readonly pid = 4242;
  exitCode: number | null = null;
  readonly signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

/** Claim publishes stay in flight until the test settles each one, in whatever order it likes. */
class GatedClaimOwnership implements ForeignDeviceOwnership {
  readonly pending: Array<(outcome: boolean | Error) => void> = [];
  /** Devices whose claim is currently published. */
  readonly held = new Set<string>();
  readonly released: string[] = [];

  async refresh(): Promise<void> {}

  foreignOwnerPid(): number | undefined {
    return undefined;
  }

  claim(deviceId: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.pending.push((outcome) => {
        if (outcome instanceof Error) {
          reject(outcome);
          return;
        }
        if (outcome) {
          this.held.add(deviceId);
        }
        resolve(outcome);
      });
    });
  }

  release(deviceId: string): void {
    this.released.push(deviceId);
    this.held.delete(deviceId);
  }
}

type Outcome =
  | { ok: true; payload: { runtime: { session: { sessionUuid: string } } } }
  | { ok: false; error: unknown };

describe.each([
  ["explicit bind", "0"],
  ["autolock", "1"],
])(
  "request cancelled while an acquisition publishes its cross-daemon claim (%s)",
  (_, autolock) => {
    let timer: FakeTimer;
    let sessions: SessionManager;
    let devices: FakeDeviceUtils;
    let pool: DevicePool;
    let ownership: GatedClaimOwnership;
    let bootHandle: RecordingBootHandle;

    beforeEach(() => {
      resetDeviceToolsDependencies();
      DaemonState.getInstance().reset();
      clearDirectSessionDevices();
      resetProvisionedDeviceTransportFenceForTests();
      timer = new FakeTimer();
      devices = new FakeDeviceUtils();
      devices.setBootedDevices("android", []);
      devices.setBootedDevices("ios", []);
      devices.setDeviceImages("android", [avd]);
      devices.setDeviceImages("ios", [simulator]);
      bootHandle = new RecordingBootHandle();
      devices.setMockChildProcess(avd.name, bootHandle as unknown as ChildProcess);
      devices.setMockChildProcess(simulator.name, bootHandle as unknown as ChildProcess);
      ownership = new GatedClaimOwnership();
      const idGenerator = new CountingIdGenerator("cancel-claim");
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
        ensureCtrlProxyReady: async () => {},
        timer,
        idGenerator,
      });
      PlatformDeviceManagerFactory.setInstance(devices);
      setDeviceManager(devices);
      sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      pool = new DevicePool(
        createDevicePoolDependencies(sessions, "cancel-claim-daemon", {
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

    const call = (
      tool: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
      client = "mcp-client",
    ) =>
      ToolRegistry.getTool(tool)!.handler(
        { ...args, __mcpSessionId: client },
        undefined,
        signal,
      ) as Promise<{ content: Array<{ text: string }> }>;

    const acquire = (
      tool: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
      client?: string,
    ): Promise<Outcome> =>
      call(tool, args, signal, client).then(
        (response) => ({ ok: true as const, payload: JSON.parse(response.content[0].text) }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    const untilClaimsPending = async (count: number): Promise<void> => {
      for (let turn = 0; turn < 5_000 && ownership.pending.length < count; turn++) {
        await Promise.resolve();
      }
      expect(ownership.pending.length).toBe(count);
    };

    /** Run an acquisition up to its in-flight claim and cancel the request there. */
    const cancelledAtClaim = async (tool: string, args: Record<string, unknown>) => {
      const controller = new AbortController();
      const outcome = acquire(tool, args, controller.signal);
      await untilClaimsPending(1);
      controller.abort(new Error("client cancelled"));
      await spin();
      return { settled: outcome };
    };

    const expectNothingBound = (deviceId: string): void => {
      const pooled = pool.getDevice(deviceId);
      expect({ session: pooled?.sessionId ?? null, status: pooled?.status }).toEqual({
        session: null,
        status: "idle",
      });
      expect(sessions.getAllSessions()).toEqual([]);
      expect([...ownership.held]).toEqual([]);
    };

    test("control: an uncancelled getApple binds its session once the claim is published", async () => {
      const outcome = acquire("getApple", { udid: SIM_UDID });
      await untilClaimsPending(1);
      ownership.pending[0](true);
      const settled = await outcome;

      expect(settled.ok).toBe(true);
      expect(pool.getDevice(SIM_UDID)?.sessionId).toBe(
        settled.ok ? settled.payload.runtime.session.sessionUuid : undefined,
      );
      expect([...ownership.held]).toEqual([SIM_UDID]);
      expect(bootHandle.killed).toBe(false);
    });

    test.each([
      ["getApple", { udid: SIM_UDID }, SIM_UDID],
      ["getAndroid", { avdName: avd.name }, AVD_SERIAL],
      ["startDevice", { platform: "ios", deviceId: SIM_UDID }, SIM_UDID],
      ["startDevice", { platform: "android", name: avd.name }, AVD_SERIAL],
    ] as const)(
      "%s %j: the cancelled cold boot leaves no session bound and no claim published",
      async (tool, args, deviceId) => {
        const cancelled = await cancelledAtClaim(tool, args);
        ownership.pending[0](true);
        const settled = await cancelled.settled;
        await drain();

        expect(settled.ok).toBe(false);
        expectNothingBound(deviceId);
        expect(ownership.released).toEqual([deviceId]);
      },
    );

    test("provisionDevice: the cancelled call leaves no session bound to the device it prepared", async () => {
      const controller = new AbortController();
      const response = call(
        "provisionDevice",
        {
          device: { platform: "android", name: avd.name, spec: ANDROID_SPEC },
          boot: true,
          readiness: "automation",
        },
        controller.signal,
      ).then(
        (result) => JSON.parse(result.content[0].text) as { sessionId?: string },
        () => ({ sessionId: undefined }),
      );
      await untilClaimsPending(1);
      controller.abort(new Error("client cancelled"));
      await spin();
      ownership.pending[0](true);
      const payload = await response;
      await drain();

      expect(payload.sessionId).toBeUndefined();
      expectNothingBound(AVD_SERIAL);
    });

    test("the acquisition deadline passing during the publish leaves nothing bound either", async () => {
      const outcome = acquire("startDevice", {
        platform: "android",
        name: avd.name,
        timeoutMs: 20_000,
      });
      await untilClaimsPending(1);
      timer.advanceTime(20_000);
      const settled = await outcome;
      // The call has already failed, and the session it committed is still bound.
      expect(settled.ok).toBe(false);
      expect(pool.getDevice(AVD_SERIAL)?.sessionId).toBeTruthy();
      ownership.pending[0](true);
      await drain();

      expectNothingBound(AVD_SERIAL);
    });

    test("a device that was already running stays running and idle", async () => {
      devices.setBootedDevices("ios", [bootedSimulator]);
      await pool.initializeWithDevices([bootedSimulator]);

      const cancelled = await cancelledAtClaim("getApple", { udid: SIM_UDID });
      ownership.pending[0](true);
      const settled = await cancelled.settled;
      await drain();

      expect(settled.ok).toBe(false);
      expectNothingBound(SIM_UDID);
      expect(bootHandle.killed).toBe(false);
      expect(devices.wasMethodCalled("killDevice")).toBe(false);
    });

    test("a claim another daemon wins after the cancel is rolled back the same way", async () => {
      const cancelled = await cancelledAtClaim("getAndroid", { avdName: avd.name });
      ownership.pending[0](false);
      const settled = await cancelled.settled;
      await drain();

      expect(settled.ok).toBe(false);
      expectNothingBound(AVD_SERIAL);
    });

    test("a claim publish that fails releases the session the failed call created", async () => {
      const outcome = acquire("getAndroid", { avdName: avd.name });
      await untilClaimsPending(1);
      ownership.pending[0](new Error("claim directory is not writable"));
      const settled = await outcome;
      await drain();

      expect(settled.ok).toBe(false);
      expectNothingBound(AVD_SERIAL);
    });

    test("the session a cancelled repeat call reused stays bound to its owner", async () => {
      devices.setBootedDevices("ios", [bootedSimulator]);
      await pool.initializeWithDevices([bootedSimulator]);
      const first = acquire("getApple", { udid: SIM_UDID });
      await untilClaimsPending(1);
      ownership.pending[0](true);
      const held = await first;
      expect(held.ok).toBe(true);
      const sessionUuid = held.ok ? held.payload.runtime.session.sessionUuid : "";

      const controller = new AbortController();
      const repeat = acquire("getApple", { udid: SIM_UDID }, controller.signal);
      await untilClaimsPending(2);
      controller.abort(new Error("client cancelled"));
      await spin();
      ownership.pending[1](true);
      await repeat;
      await drain();

      expect(pool.getDevice(SIM_UDID)?.sessionId).toBe(sessionUuid);
      expect(sessions.getSession(sessionUuid)?.assignedDevice).toBe(SIM_UDID);
      expect([...ownership.held]).toEqual([SIM_UDID]);
    });

    test("owner disconnect: the bindings released with the connection are not released twice", async () => {
      devices.setBootedDevices("ios", [bootedSimulator]);
      await pool.initializeWithDevices([bootedSimulator]);
      const releases: string[] = [];
      const releaseSession = sessions.releaseSession.bind(sessions);
      sessions.releaseSession = async (sessionId, ...rest) => {
        releases.push(sessionId);
        return await releaseSession(sessionId, ...rest);
      };

      const cancelled = await cancelledAtClaim("getApple", { udid: SIM_UDID });
      pool.releaseMcpSessionBindings("mcp-client");
      await drain();
      ownership.pending[0](true);
      const settled = await cancelled.settled;
      await drain();

      expect(settled.ok).toBe(false);
      expectNothingBound(SIM_UDID);
      expect(new Set(releases).size).toBe(releases.length);
    });

    test("daemon shutdown: a claim that lands after the sessions were released is withdrawn", async () => {
      devices.setBootedDevices("ios", [bootedSimulator]);
      await pool.initializeWithDevices([bootedSimulator]);

      const cancelled = await cancelledAtClaim("getApple", { udid: SIM_UDID });
      const sessionUuid = pool.getDevice(SIM_UDID)!.sessionId!;
      await sessions.releaseSession(sessionUuid, "daemon-shutdown");
      await pool.releaseDevice(SIM_UDID, sessionUuid);
      pool.releaseDeviceClaimsForShutdown();
      ownership.pending[0](true);
      const settled = await cancelled.settled;
      await drain();

      expect(settled.ok).toBe(false);
      expectNothingBound(SIM_UDID);
    });

    // The compensation decides from the request signal right after the publish settles. Whatever
    // the cancel's timing relative to that decision, the two sides must agree: the caller holds the
    // bound session's id, or it holds an error and nothing is bound.
    test.each(Array.from({ length: 48 }, (_, turns) => turns))(
      "a cancel %i microtasks after the publish settles never splits the caller from the pool",
      async (turns) => {
        devices.setBootedDevices("ios", [bootedSimulator]);
        await pool.initializeWithDevices([bootedSimulator]);
        const controller = new AbortController();
        const outcome = acquire("getApple", { udid: SIM_UDID }, controller.signal);
        await untilClaimsPending(1);
        ownership.pending[0](true);
        await spin(turns);
        controller.abort(new Error("client cancelled"));
        const settled = await outcome;
        await drain();

        if (settled.ok) {
          const sessionUuid = settled.payload.runtime.session.sessionUuid;
          expect(pool.getDevice(SIM_UDID)?.sessionId).toBe(sessionUuid);
          expect(sessions.getSession(sessionUuid)?.assignedDevice).toBe(SIM_UDID);
          expect([...ownership.held]).toEqual([SIM_UDID]);
        } else {
          expectNothingBound(SIM_UDID);
        }
      },
    );

    test("a second caller queued on the device acquires it once the cancelled bind is undone", async () => {
      devices.setBootedDevices("ios", [bootedSimulator]);
      await pool.initializeWithDevices([bootedSimulator]);

      const cancelled = await cancelledAtClaim("getApple", { udid: SIM_UDID });
      const orphan = pool.getDevice(SIM_UDID)!.sessionId!;
      const second = acquire("getApple", { udid: SIM_UDID }, undefined, "other-client");
      await spin();
      // The cancelled request keeps the simulator's lifecycle lease until its bind has settled.
      expect(ownership.pending.length).toBe(1);
      ownership.pending[0](true);
      await cancelled.settled;
      await untilClaimsPending(2);
      ownership.pending[1](true);
      const acquired = await second;
      await drain();

      expect(acquired.ok).toBe(true);
      const sessionUuid = acquired.ok ? acquired.payload.runtime.session.sessionUuid : "";
      expect(sessionUuid).not.toBe(orphan);
      expect(pool.getDevice(SIM_UDID)?.sessionId).toBe(sessionUuid);
      expect(sessions.getAllSessions().map((session) => session.sessionId)).toEqual([sessionUuid]);
      expect([...ownership.held]).toEqual([SIM_UDID]);
    });
  },
);
