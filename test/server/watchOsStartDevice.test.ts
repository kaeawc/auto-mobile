import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { toolJson } from "../helpers/toolResponse";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { startDeviceOutputSchema } from "../../src/server/toolOutputSchemas";
import { clearDirectSessionDevices } from "../../src/utils/directSessionDeviceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError, type BootedDevice } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { WatchSimulatorInventory } from "../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import { WatchSimulatorLifecycle } from "../../src/utils/ios-cmdline-tools/WatchSimulatorLifecycle";
import type { AppleDevice } from "../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWatchLifecycleSimctl, IPHONE_UDID, watchDevice } from "../fakes/FakeWatchSimctl";

isolateToolRegistry();

// startDevice on an Apple Watch simulator boots (or adopts) it and binds a pooled session at
// readiness "booted", with no automation-runner step anywhere on the way (#14908).

const WATCH_UDID = watchDevice().udid;
const WATCH_NAME = watchDevice().name;
const boundSessionSchema = z.object({
  runtime: z.object({ session: z.object({ sessionUuid: z.string() }) }),
});

describe("startDevice on an Apple Watch simulator", () => {
  const env: Record<string, string | undefined> = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
  let restoreEnv: (() => void) | undefined;
  let sessionManager: SessionManager | undefined;

  const cleanup = () => {
    env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "0";
    restoreEnv?.();
    restoreEnv = undefined;
    resetDeviceToolsDependencies();
    clearDirectSessionDevices();
    DaemonState.getInstance().reset();
    sessionManager?.stopCleanupTimer();
    sessionManager = undefined;
  };
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(cleanup);

  async function arrange(
    devices: AppleDevice[] = [watchDevice()],
    { listingFollowsBoot = true }: { listingFollowsBoot?: boolean } = {},
  ) {
    restoreEnv = ToolRegistry.setPipelineOverridesForTesting({ env });
    const simctl = new FakeWatchLifecycleSimctl(devices);
    const inventory = new WatchSimulatorInventory(simctl, "arm64");
    const deviceUtils = new FakeDeviceUtils();
    const publishBootedWatches = () =>
      deviceUtils.setBootedDevices(
        "watchos",
        devices
          .filter((device) => device.state === "Booted")
          .map((device): BootedDevice => ({
            name: device.name,
            platform: "watchos",
            deviceId: device.udid,
          })),
      );
    publishBootedWatches();
    simctl.onStateChange = listingFollowsBoot ? publishBootedWatches : undefined;
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        env,
        timer,
        deviceManager: deviceUtils,
      }),
    );
    // A watch booted before the call is already a pooled, idle row.
    await pool.initializeWithDevices(await deviceUtils.getBootedDevices("watchos"));
    DaemonState.getInstance().initialize(sessionManager, pool);
    const runnerCalls: string[] = [];
    setDeviceToolsDependencies({
      env,
      timer,
      deviceManagerFactory: () => deviceUtils,
      idGenerator: new CountingIdGenerator("session"),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async (request) => {
        runnerCalls.push(request.device.deviceId);
        throw new Error("a watch start must never prepare an automation runner");
      },
      watchSimulatorLifecycleFactory: () => new WatchSimulatorLifecycle(simctl, inventory),
    });
    registerDeviceTools();
    return { simctl, pool, sessions: sessionManager, runnerCalls, deviceUtils };
  }

  const start = (args: Record<string, unknown>) =>
    ToolRegistry.getTool("startDevice")!.handler({ __mcpSessionId: "client-a", ...args });

  test.each(["0", "1"])(
    "autolock %s: boots a shutdown watch and binds a pooled watchos session without any runner step",
    async (autolock) => {
      env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = autolock;
      const { simctl, pool, sessions, runnerCalls } = await arrange();

      const result = toolJson(await start({ platform: "watchos", deviceId: WATCH_UDID }));

      expect(simctl.commands).toEqual([`boot ${WATCH_UDID} 360000`]);
      expect(runnerCalls).toEqual([]);
      const sessionId = boundSessionSchema.parse(result).runtime.session.sessionUuid;
      expect(pool.getDevice(WATCH_UDID)).toMatchObject({ platform: "watchos", sessionId });
      expect(sessions.getSession(sessionId)).toMatchObject({
        platform: "watchos",
        assignedDevice: WATCH_UDID,
      });
      expect(sessions.getSession(sessionId)?.cacheData.deviceReadiness).toBe("booted");
      expect(result).toMatchObject({
        runtime: { lifecycle: { state: "booted" } },
        message: `watchos '${WATCH_NAME}' is booted (started by this call)`,
        platform: "watchos",
        acquisition: "cold-boot",
        readiness: { level: "booted", checks: ["bootCompleted", "sessionBound"] },
      });
      expect(startDeviceOutputSchema.safeParse(result).success).toBe(true);
    },
  );

  test("adopts an already-booted, pooled idle watch by exact name without booting it", async () => {
    const { simctl, pool } = await arrange([watchDevice({ state: "Booted" })]);
    expect(pool.getDevice(WATCH_UDID)).toMatchObject({ platform: "watchos", sessionId: null });

    const result = toolJson(await start({ device: { platform: "watchos", name: WATCH_NAME } }));

    expect(simctl.commands).toEqual([]);
    expect(result).toMatchObject({ acquisition: "already-booted", platform: "watchos" });
    expect(pool.getDevice(WATCH_UDID)?.sessionId).not.toBeNull();
  });

  test("refuses to bind a watch no fresh watchOS listing shows booted", async () => {
    const { simctl, pool } = await arrange([watchDevice()], { listingFollowsBoot: false });

    const error = await start({ platform: "watchos", deviceId: WATCH_UDID }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(simctl.commands).toEqual([`boot ${WATCH_UDID} 360000`]);
    expect(pool.getDevice(WATCH_UDID)).toBeNull();
  });

  test("refuses a pooled watch that the fresh watchOS listing no longer shows booted", async () => {
    const { simctl, pool, deviceUtils } = await arrange([watchDevice({ state: "Booted" })]);
    expect(pool.getDevice(WATCH_UDID)?.sessionId).toBeNull();
    deviceUtils.setBootedDevices("watchos", []);

    const error = await start({ platform: "watchos", deviceId: WATCH_UDID }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(simctl.commands).toEqual([]);
    expect(pool.getDevice(WATCH_UDID)?.sessionId ?? null).toBeNull();
  });

  test("refuses a pooled watch while the watchOS listing fails, instead of trusting the row", async () => {
    const { simctl, pool, deviceUtils } = await arrange([watchDevice({ state: "Booted" })]);
    deviceUtils.failedPlatforms.add("watchos");

    const error = await start({ platform: "watchos", deviceId: WATCH_UDID }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(simctl.commands).toEqual([]);
    expect(pool.getDevice(WATCH_UDID)?.sessionId ?? null).toBeNull();
  });

  test("refuses an iPhone UDID named as a watch before any simctl command", async () => {
    const { simctl, pool } = await arrange();

    const error = await start({ platform: "watchos", deviceId: IPHONE_UDID }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`No Apple Watch simulator matches UDID ${IPHONE_UDID}`);
    expect(simctl.commands).toEqual([]);
    expect(pool.getDevice(IPHONE_UDID)).toBeNull();
  });

  test.each([
    ["createIfMissing", { createIfMissing: true }],
    ["avdName", { avdName: "Pixel_8" }],
    ["runnerReadinessTimeoutMs", { runnerReadinessTimeoutMs: 60_000 }],
    ["formFactor", { formFactor: "watch" }],
  ])("refuses the Android/iOS-only option %s for a watch", async (key, option) => {
    const { simctl } = await arrange();

    const error = await start({ platform: "watchos", deviceId: WATCH_UDID, ...option }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`unsupported option(s): ${key}`);
    expect(simctl.commands).toEqual([]);
  });

  test("the registered schema admits a watch request and keeps refusing an unknown platform", () => {
    const schema = ToolRegistry.getTool("startDevice")?.schema;
    expect(schema?.safeParse({ platform: "watchos", deviceId: WATCH_UDID }).success).toBe(true);
    expect(schema?.safeParse({ platform: "tvos", deviceId: WATCH_UDID }).success).toBe(false);
  });
});
