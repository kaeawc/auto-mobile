import { provisionAppleTvDevice } from "../../src/server/deviceToolsAppleTvProvision";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { toolJson } from "../helpers/toolResponse";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import {
  provisionDeviceRegistrationSchema,
  provisionDeviceSchema,
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
import { AppleTvSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorInventory";
import {
  AppleTvSimulatorBoot,
  type AppleTvBootAdmission,
} from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorBoot";
import { AppleTvSimulatorProvisioner } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorProvisioner";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import type { AppleDevice } from "../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  FakeAppleTvProvisionSimctl,
  TV_DEVICE_TYPE,
  TV_RUNTIME_ID,
  tvDevice,
} from "../fakes/FakeAppleTvSimctl";

isolateToolRegistry();

// provisionDevice with platform "tvos" adopts or creates an exact Apple TV simulator and,
// with boot, binds a session at readiness "booted"; no automation runner runs (#15889).

const NAME = "AutoMobile TV";
const SPEC = { deviceType: TV_DEVICE_TYPE.identifier, runtime: TV_RUNTIME_ID };
const TV = { platform: "tvos", name: NAME, spec: SPEC };
const sessionSchema = z.object({ sessionId: z.string() });

describe("provisionDevice on an Apple TV simulator", () => {
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
    devices: AppleDevice[] = [],
    { autolock = "0", admission }: { autolock?: "0" | "1"; admission?: AppleTvBootAdmission } = {},
  ) {
    env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = autolock;
    restoreEnv = ToolRegistry.setPipelineOverridesForTesting({ env });
    const simctl = new FakeAppleTvProvisionSimctl(devices);
    const inventory = new AppleTvSimulatorInventory(simctl, "arm64");
    const deviceUtils = new FakeDeviceUtils();
    const publishBootedAppleTves = () =>
      deviceUtils.setBootedDevices(
        "tvos",
        Object.values(simctl.listing.devices)
          .flat()
          .filter((device) => device.state === "Booted" && device.name !== "iPhone 16")
          .map((device): BootedDevice => ({
            name: device.name,
            platform: "tvos",
            deviceId: device.udid,
          })),
      );
    publishBootedAppleTves();
    simctl.onStateChange = publishBootedAppleTves;
    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        env,
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices(await deviceUtils.getBootedDevices("tvos"));
    DaemonState.getInstance().initialize(sessionManager, pool);
    const runnerCalls: string[] = [];
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    setDeviceToolsDependencies({
      lifecycleCoordinator,
      env,
      timer,
      deviceManagerFactory: () => deviceUtils,
      idGenerator: new CountingIdGenerator("session"),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async (request) => {
        runnerCalls.push(request.device.deviceId);
        throw new Error("a TV provision must never prepare an automation runner");
      },
      appleTvSimulatorBootFactory: () => new AppleTvSimulatorBoot(simctl, admission),
      appleTvSimulatorProvisionerFactory: () => new AppleTvSimulatorProvisioner(inventory, simctl),
    });
    registerDeviceTools();
    return { simctl, pool, sessions: sessionManager, runnerCalls, timer, lifecycleCoordinator };
  }

  const provision = (args: Record<string, unknown>) =>
    ToolRegistry.getTool("provisionDevice")!.handler({ __mcpSessionId: "client-a", ...args });

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  test("creates a missing tv, boots it and binds a TVos session without a runner", async () => {
    const { simctl, pool, sessions, runnerCalls } = await arrange();

    const result = toolJson(await provision({ device: TV }));

    const created = simctl.commands[0]!;
    expect(created).toBe(`create ${NAME} ${SPEC.deviceType} ${SPEC.runtime}`);
    const udid = Object.values(simctl.listing.devices)
      .flat()
      .find((device) => device.name === NAME)!.udid;
    // The boot gets what is left of the default 8-minute provisionDevice budget.
    expect(simctl.commands.slice(1)).toEqual([`boot ${udid} 480000`]);
    expect(runnerCalls).toEqual([]);
    const { sessionId } = sessionSchema.parse(result);
    expect(pool.getDevice(udid)).toMatchObject({ platform: "tvos", sessionId });
    expect(sessions.getSession(sessionId)?.cacheData.deviceReadiness).toBe("booted");
    expect(result).toMatchObject({
      message: `tvos '${NAME}' provisioned (ready)`,
      created: true,
      adopted: false,
      lifecycleState: "ready",
      readiness: { mode: "none", status: "device_ready" },
      requestedSpec: SPEC,
      acquisition: "cold-boot",
    });
    expect(provisionDeviceOutputSchema.safeParse(result).success).toBe(true);
  });

  test("with autolock, the bound tv session belongs to the calling connection", async () => {
    const { pool } = await arrange([], { autolock: "1" });

    const { sessionId } = sessionSchema.parse(toolJson(await provision({ device: TV })));

    expect(pool.resolveAutolockSessionForMcpSession("client-a", "tvos")).toBe(sessionId);
  });

  test("a TV shut down while provisioning waited for its lease is booted, not adopted as booted", async () => {
    const existing = tvDevice({ name: NAME, state: "Booted" });
    const { simctl, timer, lifecycleCoordinator } = await arrange([existing]);
    const shutdown = await lifecycleCoordinator.reserve(
      { kind: "stable", platform: "tvos", stableId: existing.udid },
      { operation: "shutdown", deadlineMs: timer.now() + 60_000 },
    );

    const pending = provision({ device: TV });
    for (let turn = 0; turn < 2_000; turn++) {
      await Promise.resolve();
    }
    await simctl.killSimulator({ name: NAME, platform: "tvos", deviceId: existing.udid });
    shutdown.release();
    const result = toolJson(await pending);

    expect(simctl.commands).toEqual([`shutdown ${existing.udid}`, `boot ${existing.udid} 480000`]);
    expect(result).toMatchObject({ lifecycleState: "ready", acquisition: "cold-boot" });
  });

  // A provision cancelled while its boot waits for simulator capacity must leave the admission
  // queue instead of holding its place and lease until a slot frees (#15889).
  test("a provision cancelled while its boot waits for admission cancels the admission", async () => {
    const request = new AbortController();
    const seen: Array<boolean | undefined> = [];
    await arrange([], {
      admission: {
        run: async (boot) => {
          seen.push(boot.signal?.aborted);
          request.abort();
          seen.push(boot.signal?.aborted);
          boot.signal?.throwIfAborted();
          throw new Error("admission must observe the cancelled request");
        },
      },
    });

    const outcome = await ToolRegistry.getTool("provisionDevice")!
      .handler({ __mcpSessionId: "client-a", device: TV }, undefined, request.signal)
      .then(
        () => "delivered",
        () => "refused",
      );

    expect(outcome).toBe("refused");
    expect(seen).toEqual([false, true]);
  });

  test("boot false adopts the existing TV and binds nothing", async () => {
    const existing = tvDevice({ name: NAME });
    const { simctl, pool } = await arrange([existing]);

    const result = toolJson(await provision({ device: TV, boot: false }));

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

    const readiness = await failure(provision({ device: TV, readiness: "automation" }));
    const resources = await failure(
      provision({ device: TV, resources: { animations: "disabled" } }),
    );
    const tools = await failure(provision({ device: TV, enableTools: ["observe"] }));

    expect(readiness).toBeInstanceOf(ActionableError);
    expect(String(readiness)).toContain("tvOS has no automation runner");
    expect(String(resources)).toContain("resources is not supported on tvOS");
    expect(String(tools)).toContain("enableTools is not supported on tvOS");
    expect(simctl.commands).toEqual([]);
  });

  test("a TV this call created is deleted again when its boot fails", async () => {
    const { simctl, pool } = await arrange();
    simctl.bootError = new Error("Unable to boot: CoreSimulator timed out");

    const error = await failure(provision({ device: TV }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("the TV was deleted again");
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

  test("a TV this call created is deleted again when session binding fails", async () => {
    const { simctl } = await arrange();
    const error = await failure(
      provisionAppleTvDevice({ __mcpSessionId: "client-a", device: TV }, async () => {
        throw new Error("session bind failed");
      }),
    );
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("session bind failed");
    expect(simctl.commands.map((command) => command.split(" ")[0])).toEqual([
      "create",
      "boot",
      "delete",
    ]);
    expect(Object.values(simctl.listing.devices).flat()).toEqual([]);
  });

  test("an adopted tv whose boot fails is left in place", async () => {
    const existing = tvDevice({ name: NAME });
    const { simctl } = await arrange([existing]);
    simctl.bootError = new Error("Unable to boot: CoreSimulator timed out");

    const error = await failure(provision({ device: TV }));

    expect(String(error)).toContain("CoreSimulator timed out");
    expect(simctl.commands.some((command) => command.startsWith("delete"))).toBe(false);
  });

  test("Android and iOS keep their readiness default; the registered schema gives a TV none", () => {
    const ios = provisionDeviceSchema.parse({
      device: {
        platform: "ios",
        name: "iPhone",
        spec: {
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        },
      },
    });
    const tv = provisionDeviceRegistrationSchema.parse({ device: TV });

    expect(ios).toMatchObject({ readiness: "automation", boot: true });
    expect(tv).toMatchObject({ boot: true });
    expect(tv.readiness).toBeUndefined();
  });
});
