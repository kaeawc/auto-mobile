import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "child_process";
import { EventEmitter } from "node:events";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import type { ForeignDeviceOwnership } from "../../../src/daemon/foreignDeviceOwnership";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { DeviceInfo } from "../../../src/models";
import { clearDirectSessionDevices } from "../../../src/server/directSessionDeviceRegistry";
import { setDeviceManager } from "../../../src/server/bootedDeviceResources";
import { DefaultDeviceMatcher } from "../../../src/utils/deviceMatcher";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { PlatformDeviceManagerFactory } from "../../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";

isolateToolRegistry();

// Hunt (provisioning-concurrency-4, cell 2): the last awaited step of an explicit bind is the
// cross-daemon claim publish (`claimExplicitlyBoundDevice` -> `ForeignDeviceOwnership.claim`, file
// I/O that production wires for both platforms via `DevicePool.create`). It runs AFTER the session
// is committed. A client cancel that lands there rejects the tool call at once (the bind is raced
// against the request signal), but the bind then completes and nothing compensates it: the caller
// holds an error and no sessionUuid while the device stays busy under a session it never received.
// On iOS the failed request also shuts down the simulator it cold-booted, underneath that session.

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

/** A claim publish that stays in flight until the test lets it finish (it then succeeds). */
class GatedClaimOwnership implements ForeignDeviceOwnership {
  pendingClaims = 0;
  readonly released: string[] = [];
  private finish!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.finish = resolve;
  });

  finishClaims(): void {
    this.finish();
  }

  async refresh(): Promise<void> {}

  foreignOwnerPid(): number | undefined {
    return undefined;
  }

  async claim(): Promise<boolean> {
    this.pendingClaims++;
    await this.gate;
    return true;
  }

  release(deviceId: string): void {
    this.released.push(deviceId);
  }
}

describe("client cancel while an acquisition publishes its cross-daemon claim", () => {
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
    const idGenerator = new CountingIdGenerator("hunt-cancel-claim");
    const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
    setDeviceToolsDependencies({
      env,
      deviceManagerFactory: () => devices,
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async () => {},
      timer,
      idGenerator,
    });
    PlatformDeviceManagerFactory.setInstance(devices);
    setDeviceManager(devices);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "hunt-cancel-claim-daemon", {
        env,
        timer,
        idGenerator,
        deviceManager: devices,
        installedAppsRepository: new FakeInstalledAppsRepository(),
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
    setDeviceManager(null);
    PlatformDeviceManagerFactory.reset();
    timer.reset();
  });

  const spin = async (turns = 200): Promise<void> => {
    for (let turn = 0; turn < turns; turn++) {
      await Promise.resolve();
    }
  };

  const acquire = (tool: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    (
      ToolRegistry.getTool(tool)!.handler(
        { ...args, __mcpSessionId: "mcp-client" },
        undefined,
        signal,
      ) as Promise<{ content: Array<{ text: string }> }>
    ).then(
      (response) => ({ ok: true as const, payload: JSON.parse(response.content[0].text) }),
      (error: unknown) => ({ ok: false as const, error }),
    );

  /** Run the acquisition up to the in-flight claim, cancel it there, then let the claim finish. */
  const cancelDuringClaim = async (tool: string, args: Record<string, unknown>) => {
    const controller = new AbortController();
    const outcome = acquire(tool, args, controller.signal);
    for (let turn = 0; turn < 5_000 && ownership.pendingClaims === 0; turn++) {
      await Promise.resolve();
    }
    expect(ownership.pendingClaims).toBe(1);
    controller.abort(new Error("client cancelled"));
    await spin();
    ownership.finishClaims();
    const settled = await outcome;
    // Give every deferred cancellation settlement and grace timer room to run.
    for (let second = 0; second < 10; second++) {
      await spin();
      timer.advanceTime(1_000);
    }
    await spin();
    return settled;
  };

  // Control: the same harness binds normally when nothing cancels.
  test("control: an uncancelled getApple binds its session once the claim is published", async () => {
    const outcome = acquire("getApple", { udid: SIM_UDID });
    for (let turn = 0; turn < 5_000 && ownership.pendingClaims === 0; turn++) {
      await Promise.resolve();
    }
    ownership.finishClaims();
    const settled = await outcome;

    expect(settled.ok).toBe(true);
    expect(pool.getDevice(SIM_UDID)?.sessionId).toBe(
      settled.ok ? settled.payload.runtime.session.sessionUuid : undefined,
    );
    expect(bootHandle.killed).toBe(false);
  });

  test("getApple: the cancelled call leaves no session bound to the simulator it shut down", async () => {
    const settled = await cancelDuringClaim("getApple", { udid: SIM_UDID });

    // The caller was told the acquisition failed and received no sessionUuid.
    expect(settled.ok).toBe(false);
    const pooled = pool.getDevice(SIM_UDID);
    // Actual: the simulator was shut down (killed === true) AND is still busy under a session.
    expect({
      boundSession: pooled?.sessionId ?? null,
      status: pooled?.status ?? "absent",
      shutDownUnderSession: bootHandle.killed && Boolean(pooled?.sessionId),
    }).toEqual({ boundSession: null, status: "idle", shutDownUnderSession: false });
    expect(sessions.getAllSessions()).toEqual([]);
  });

  test("getAndroid: the cancelled call leaves no session bound to the emulator", async () => {
    const settled = await cancelDuringClaim("getAndroid", { avdName: avd.name });

    expect(settled.ok).toBe(false);
    const pooled = pool.getDevice(AVD_SERIAL);
    expect(pooled?.sessionId ?? null).toBeNull();
    expect(sessions.getAllSessions()).toEqual([]);
  });
});
