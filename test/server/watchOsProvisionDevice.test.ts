import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { toolJson } from "../helpers/toolResponse";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import {
  provisionDeviceRegistrationSchema,
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { provisionDeviceOutputSchema } from "../../src/features/deviceLifecycle/core/toolSchemas";
import { clearDirectSessionDevices } from "../../src/utils/directSessionDeviceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError, type BootedDevice } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { WatchSimulatorInventory } from "../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import { WatchSimulatorLifecycle } from "../../src/utils/ios-cmdline-tools/WatchSimulatorLifecycle";
import { WatchSimulatorProvisioner } from "../../src/utils/ios-cmdline-tools/WatchSimulatorProvisioner";
import type { AppleDevice } from "../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  FakeWatchProvisionSimctl,
  WATCH_DEVICE_TYPE,
  WATCH_RUNTIME_ID,
  watchDevice,
} from "../fakes/FakeWatchSimctl";

isolateToolRegistry();

// provisionDevice with platform "watchos" adopts or creates an exact Apple Watch simulator and,
// with boot, binds a session at readiness "booted"; no automation runner runs (#15882).

const NAME = "AutoMobile Watch";
const SPEC = { deviceType: WATCH_DEVICE_TYPE.identifier, runtime: WATCH_RUNTIME_ID };
const WATCH = { platform: "watchos", name: NAME, spec: SPEC };
const sessionSchema = z.object({ sessionId: z.string() });

describe("provisionDevice on an Apple Watch simulator", () => {
  const env: Record<string, string | undefined> = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
  let restoreEnv: (() => void) | undefined;
  let sessionManager: SessionManager | undefined;

  const cleanup = () => {
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

  async function arrange(devices: AppleDevice[] = []) {
    restoreEnv = ToolRegistry.setPipelineOverridesForTesting({ env });
    const simctl = new FakeWatchProvisionSimctl(devices);
    const inventory = new WatchSimulatorInventory(simctl, "arm64");
    const deviceUtils = new FakeDeviceUtils();
    const publishBootedWatches = () =>
      deviceUtils.setBootedDevices(
        "watchos",
        Object.values(simctl.listing.devices)
          .flat()
          .filter((device) => device.state === "Booted" && device.name !== "iPhone 16")
          .map((device): BootedDevice => ({
            name: device.name,
            platform: "watchos",
            deviceId: device.udid,
          })),
      );
    publishBootedWatches();
    simctl.onStateChange = publishBootedWatches;
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        env,
        timer,
        deviceManager: deviceUtils,
      }),
    );
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
        throw new Error("a watch provision must never prepare an automation runner");
      },
      watchSimulatorLifecycleFactory: () => new WatchSimulatorLifecycle(simctl, inventory),
      watchSimulatorProvisionerFactory: () => new WatchSimulatorProvisioner(inventory, simctl),
    });
    registerDeviceTools();
    return { simctl, pool, sessions: sessionManager, runnerCalls };
  }

  const provision = (args: Record<string, unknown>) =>
    ToolRegistry.getTool("provisionDevice")!.handler({ __mcpSessionId: "client-a", ...args });

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  test("creates a missing watch, boots it and binds a watchos session without a runner", async () => {
    const { simctl, pool, sessions, runnerCalls } = await arrange();

    const result = toolJson(await provision({ device: WATCH }));

    const created = simctl.commands[0]!;
    expect(created).toBe(`create ${NAME} ${SPEC.deviceType} ${SPEC.runtime}`);
    const udid = Object.values(simctl.listing.devices)
      .flat()
      .find((device) => device.name === NAME)!.udid;
    // The boot gets what is left of the default 8-minute provisionDevice budget.
    expect(simctl.commands.slice(1)).toEqual([`boot ${udid} 480000`]);
    expect(runnerCalls).toEqual([]);
    const { sessionId } = sessionSchema.parse(result);
    expect(pool.getDevice(udid)).toMatchObject({ platform: "watchos", sessionId });
    expect(sessions.getSession(sessionId)?.cacheData.deviceReadiness).toBe("booted");
    expect(result).toMatchObject({
      message: `watchos '${NAME}' provisioned (ready)`,
      created: true,
      adopted: false,
      lifecycleState: "ready",
      readiness: { mode: "none", status: "device_ready" },
      requestedSpec: SPEC,
      acquisition: "cold-boot",
    });
    expect(provisionDeviceOutputSchema.safeParse(result).success).toBe(true);
  });

  test("boot false adopts the existing watch and binds nothing", async () => {
    const existing = watchDevice({ name: NAME });
    const { simctl, pool } = await arrange([existing]);

    const result = toolJson(await provision({ device: WATCH, boot: false }));

    expect(simctl.commands).toEqual([]);
    expect(pool.getDevice(existing.udid)).toBeNull();
    expect(result).toMatchObject({
      created: false,
      adopted: true,
      lifecycleState: "adopted",
      readiness: { mode: "none", status: "not_requested" },
    });
    expect(result).not.toHaveProperty("sessionId");
    expect(provisionDeviceOutputSchema.safeParse(result).success).toBe(true);
  });

  test("refuses readiness automation, resources and enableTools before any simctl call", async () => {
    const { simctl } = await arrange();

    const readiness = await failure(provision({ device: WATCH, readiness: "automation" }));
    const resources = await failure(
      provision({ device: WATCH, resources: { animations: "disabled" } }),
    );
    const tools = await failure(provision({ device: WATCH, enableTools: ["observe"] }));

    expect(readiness).toBeInstanceOf(ActionableError);
    expect(String(readiness)).toContain("watchOS has no automation runner");
    expect(String(resources)).toContain("resources is not supported on watchOS");
    expect(String(tools)).toContain("enableTools is not supported on watchOS");
    expect(simctl.commands).toEqual([]);
  });

  test("a watch this call created is deleted again when its boot fails", async () => {
    const { simctl, pool } = await arrange();
    simctl.bootError = new Error("Unable to boot: CoreSimulator timed out");

    const error = await failure(provision({ device: WATCH }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("the watch was deleted again");
    expect(String(error)).toContain("CoreSimulator timed out");
    const udid = simctl.commands.at(-1)!.replace("delete ", "");
    expect(simctl.commands.map((command) => command.split(" ")[0])).toEqual([
      "create",
      "boot",
      "delete",
    ]);
    expect(
      Object.values(simctl.listing.devices)
        .flat()
        .map((d) => d.udid),
    ).not.toContain(udid);
    expect(pool.getDevice(udid)).toBeNull();
  });

  test("an adopted watch whose boot fails is left in place", async () => {
    const existing = watchDevice({ name: NAME });
    const { simctl } = await arrange([existing]);
    simctl.bootError = new Error("Unable to boot: CoreSimulator timed out");

    const error = await failure(provision({ device: WATCH }));

    expect(String(error)).toContain("CoreSimulator timed out");
    expect(simctl.commands.some((command) => command.startsWith("delete"))).toBe(false);
  });

  test("the registered schema keeps Android and iOS defaults and defaults a watch to none", () => {
    const ios = provisionDeviceRegistrationSchema.parse({
      device: {
        platform: "ios",
        name: "iPhone",
        spec: {
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        },
      },
    });
    const watch = provisionDeviceRegistrationSchema.parse({ device: WATCH });

    expect(ios).toMatchObject({ readiness: "automation", boot: true });
    expect(watch).toMatchObject({ readiness: "none", boot: true });
  });
});
