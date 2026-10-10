import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "child_process";
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
import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../../src/devices/virtualDeviceLifecycleCoordinator";
import type { DeviceInfo } from "../../../src/models";
import { DeviceAlreadyRunningError } from "../../../src/models/DeviceAlreadyRunningError";
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

// Hunt (provisioning-concurrency-4, cell 1): two starts whose selectors differ but resolve to the
// same stopped device. #9902 fixed iOS: the loser re-checks after the device's lifecycle lease
// settles and adopts the simulator the winner booted. Android gates that re-check on the in-flight
// cold-boot marker, which `bootMatchedImage` reads BEFORE it waits for the AVD's lease. When both
// starts queue behind a lease someone else briefly holds (a kill still confirming the emulator's
// exit, a configure), neither has claimed the marker yet, so the loser later cold-boots an AVD
// that is now running and fails with the untyped "already running".

/**
 * `FakeDeviceUtils.startDevice` boots a running image again without complaint. The real
 * `PlatformDeviceManager.startDeviceWithOutcome` (src/devices/deviceUtils.ts) refuses it with
 * `DeviceAlreadyRunningError`; this models that one contract and nothing else.
 */
class RefusingRunningImageDeviceUtils extends FakeDeviceUtils {
  override async startDevice(device: DeviceInfo, timeoutMs?: number): Promise<ChildProcess | null> {
    if (await this.isDeviceImageRunning(device)) {
      throw new DeviceAlreadyRunningError(
        `${device.platform} device '${device.name}' is already running`,
        device.platform,
        device.deviceId,
      );
    }
    return await super.startDevice(device, timeoutMs);
  }
}

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

type Outcome =
  | { ok: true; payload: Record<string, any> }
  | { ok: false; error: { code?: string; message?: string } };

describe("two starts that resolve to one device, queued behind its lifecycle lease", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let devices: RefusingRunningImageDeviceUtils;
  let coordinator: InMemoryVirtualDeviceLifecycleCoordinator;

  beforeEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    clearDirectSessionDevices();
    timer = new FakeTimer();
    devices = new RefusingRunningImageDeviceUtils();
    devices.setBootedDevices("android", []);
    devices.setBootedDevices("ios", []);
    devices.setDeviceImages("android", [avd]);
    devices.setDeviceImages("ios", [simulator]);
    coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const idGenerator = new CountingIdGenerator("hunt-queued-start");
    const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
    setDeviceToolsDependencies({
      env,
      deviceManagerFactory: () => devices,
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async () => {},
      lifecycleCoordinator: coordinator,
      timer,
      idGenerator,
    });
    PlatformDeviceManagerFactory.setInstance(devices);
    setDeviceManager(devices);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "hunt-queued-start-daemon", {
        env,
        timer,
        idGenerator,
        deviceManager: devices,
        installedAppsRepository: new FakeInstalledAppsRepository(),
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

  const spin = async (turns = 400): Promise<void> => {
    for (let turn = 0; turn < turns; turn++) {
      await Promise.resolve();
    }
  };

  const start = (args: Record<string, unknown>): Promise<Outcome> =>
    (
      ToolRegistry.getTool("startDevice")!.handler(args) as Promise<{
        content: Array<{ text: string }>;
      }>
    ).then(
      (response): Outcome => ({ ok: true, payload: JSON.parse(response.content[0].text) }),
      (error: { code?: string; message?: string }): Outcome => ({ ok: false, error }),
    );

  /**
   * Another operation holds the device's stable lifecycle key (as a kill does until the emulator
   * has exited). Two starts with different selectors arrive seconds apart, both resolve to that
   * device and queue behind the key; then the holder finishes.
   */
  const startTwoBehindHeldLease = async (
    platform: "android" | "ios",
    secondMcpSessionId: string,
  ): Promise<[Outcome, Outcome]> => {
    const holder = await coordinator.reserve(
      { kind: "stable", platform, stableId: platform === "android" ? avd.name : SIM_UDID },
      { operation: "shutdown", deadlineMs: timer.now() + 600_000 },
    );
    const first = start({ platform, __mcpSessionId: "mcp-a" });
    await spin();
    timer.advanceTime(2_000);
    await spin();
    const second = start({ platform, formFactor: "phone", __mcpSessionId: secondMcpSessionId });
    await spin();
    timer.advanceTime(2_000);
    await spin();
    holder.release();
    let settled: [Outcome, Outcome] | undefined;
    void Promise.all([first, second]).then((outcomes) => {
      settled = outcomes;
    });
    for (let elapsedSeconds = 0; elapsedSeconds < 30 && !settled; elapsedSeconds++) {
      await spin();
      timer.advanceTime(1_000);
    }
    expect(settled).toBeDefined();
    return settled!;
  };

  // Control: iOS (#9902) serves the queued start from the simulator the first one booted.
  test("control: the same client's queued iOS start adopts the booted simulator", async () => {
    const [first, second] = await startTwoBehindHeldLease("ios", "mcp-a");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.ok && second.payload.acquisition).toBe("already-booted");
    expect(second.ok && second.payload.runtime.session.sessionUuid).toBe(
      first.ok ? first.payload.runtime.session.sessionUuid : undefined,
    );
  });

  test("the same client's queued Android start adopts the emulator the first start booted", async () => {
    const [first, second] = await startTwoBehindHeldLease("android", "mcp-a");

    expect(first.ok).toBe(true);
    // Actual: { ok: false, error: DeviceAlreadyRunningError "android device '…' is already running" }.
    expect(second.ok ? "adopted" : second.error.message).toBe("adopted");
    expect(second.ok && second.payload.acquisition).toBe("already-booted");
    expect(second.ok && second.payload.runtime.session.sessionUuid).toBe(
      first.ok ? first.payload.runtime.session.sessionUuid : undefined,
    );
  });

  test("another client's queued Android start gets the typed held-device refusal", async () => {
    const [first, second] = await startTwoBehindHeldLease("android", "mcp-b");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    // iOS answers device_owned_by_other_session here; Android answers an untyped "already running".
    expect(second.ok ? undefined : (second.error.code ?? second.error.message)).toBe(
      DEVICE_OWNED_BY_OTHER_SESSION_CODE,
    );
  });
});
