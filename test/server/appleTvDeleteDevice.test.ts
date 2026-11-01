import { AppleTvSimulatorBoot } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorBoot";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { toolJson } from "../helpers/toolResponse";
import { settleByFakeEvents } from "../helpers/fakeTimerStepping";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { clearDirectSessionDevices } from "../../src/utils/directSessionDeviceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { ActionableError, type BootedDevice } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { AppleTvSimulatorInventory } from "../../src/utils/ios-cmdline-tools/AppleTvSimulatorInventory";
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

// deleteDevice on an Apple TV simulator applies killDevice's caller checks, stops a running
// tv, deletes it with simctl and proves it gone from a fresh TV listing (#15889).

const NAME = "AutoMobile TV";
const SPEC = { deviceType: TV_DEVICE_TYPE.identifier, runtime: TV_RUNTIME_ID };
const TV = { platform: "tvos", name: NAME, spec: SPEC };
const sessionSchema = z.object({ sessionId: z.string() });

describe("deleteDevice on an Apple TV simulator", () => {
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
    { autolock = "0" }: { autolock?: "0" | "1" } = {},
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
    // killDevice's platform kill for a TV is simctl shutdown, which the listing then reflects.
    deviceUtils.killDevice = async (device) => {
      await simctl.killSimulator(device);
    };
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
      appleTvSimulatorBootFactory: () => new AppleTvSimulatorBoot(simctl),
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

  const remove = (args: Record<string, unknown>, connection = "client-a") =>
    ToolRegistry.getTool("deleteDevice")!.handler({
      __mcpSessionId: connection,
      mode: "destroy",
      verifyAbsence: true,
      ...args,
    });

  const target = (udid: string, extra: Record<string, unknown> = {}) => ({
    target: { platform: "tvos", isVirtual: true, stableId: udid, ...extra },
  });

  const listed = (simctl: FakeAppleTvProvisionSimctl) =>
    Object.values(simctl.listing.devices)
      .flat()
      .map((device) => device.udid);

  test("deletes a stopped TV and confirms it absent from a fresh listing", async () => {
    const tv = tvDevice({ name: NAME });
    const { simctl } = await arrange([tv]);

    const result = toolJson(await remove(target(tv.udid)));

    expect(result).toMatchObject({
      state: "destroyed",
      target: { platform: "tvos", stableId: tv.udid },
      command: { stop: "not_required", destroy: "accepted" },
      verification: { notRunning: "confirmed", inventory: "complete_absence_confirmed" },
    });
    expect(simctl.commands).toEqual([`delete ${tv.udid}`]);
    expect(listed(simctl)).not.toContain(tv.udid);
  });

  test("the holding session stops its running TV, releasing the session, then deletes it", async () => {
    const { simctl, pool, sessions, timer } = await arrange();
    const { sessionId } = sessionSchema.parse(toolJson(await provision({ device: TV })));
    const udid = createdUdid(simctl);
    simctl.commands.length = 0;

    const result = toolJson(
      await settleByFakeEvents(timer, remove({ ...target(udid), sessionUuid: sessionId }), {
        description: "deleteDevice of a running TV",
      }),
    );

    expect(result).toMatchObject({
      state: "destroyed",
      command: { stop: "accepted", destroy: "accepted" },
    });
    expect(simctl.commands).toEqual([`shutdown ${udid}`, `delete ${udid}`]);
    expect(pool.getDevice(udid)).toBeNull();
    expect(sessions.getSession(sessionId)?.assignedDevice ?? null).toBeNull();
  });

  test("a TV another connection's session holds is refused, and nothing is stopped or deleted", async () => {
    const { simctl } = await arrange();
    await provision({ device: TV });
    const udid = createdUdid(simctl);
    simctl.commands.length = 0;

    const error = await failure(remove(target(udid), "client-b"));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("deleteDevice");
    expect(simctl.commands).toEqual([]);
    expect(listed(simctl)).toContain(udid);
  });

  test("an externally stopped TV its session still holds is released, then deleted", async () => {
    const { simctl, pool, sessions } = await arrange();
    const { sessionId } = sessionSchema.parse(toolJson(await provision({ device: TV })));
    const udid = createdUdid(simctl);
    await simctl.killSimulator({ name: NAME, platform: "tvos", deviceId: udid });
    expect(pool.getDevice(udid)?.sessionId).toBe(sessionId);
    simctl.commands.length = 0;

    const result = toolJson(await remove({ ...target(udid), sessionUuid: sessionId }));

    expect(result).toMatchObject({
      state: "destroyed",
      command: { stop: "not_required", destroy: "accepted" },
    });
    expect(pool.getDevice(udid)).toBeNull();
    expect(sessions.getSession(sessionId)?.assignedDevice ?? null).toBeNull();
    expect(simctl.commands).toEqual([`delete ${udid}`]);
  });

  test("timeoutMs bounds the whole delete, not just the lease wait", async () => {
    const tv = tvDevice({ name: NAME });
    const { simctl, timer } = await arrange([tv]);
    afterListing(simctl, 1, () => timer.advanceTime(50));

    const result = await remove({ ...target(tv.udid), timeoutMs: 10 });

    expect(toolJson(result)).toMatchObject({
      state: "failed",
      failure: { code: "teardown_deadline_exceeded" },
    });
    expect(simctl.commands).toEqual([]);
    expect(listed(simctl)).toContain(tv.udid);
  });

  test("an accepted delete continues after its caller goes away", async () => {
    const tv = tvDevice({ name: NAME });
    const { simctl } = await arrange([tv]);
    const caller = new AbortController();
    afterListing(simctl, 1, () => caller.abort(new Error("client disconnected")));

    const result = toolJson(
      await ToolRegistry.getTool("deleteDevice")!.handler(
        { __mcpSessionId: "client-a", mode: "destroy", verifyAbsence: true, ...target(tv.udid) },
        undefined,
        caller.signal,
      ),
    );

    expect(result).toMatchObject({ state: "destroyed" });
    expect(listed(simctl)).not.toContain(tv.udid);
  });

  test("cancel-on-request-abort stops the delete when its caller goes away", async () => {
    const tv = tvDevice({ name: NAME });
    const { simctl } = await arrange([tv]);
    const caller = new AbortController();
    afterListing(simctl, 1, () => caller.abort(new Error("client disconnected")));

    const outcome = await failure(
      ToolRegistry.getTool("deleteDevice")!.handler(
        {
          __mcpSessionId: "client-a",
          mode: "destroy",
          verifyAbsence: true,
          cancellationPolicy: "cancel-on-request-abort",
          ...target(tv.udid),
        },
        undefined,
        caller.signal,
      ),
    );

    expect(String(outcome)).toContain("client disconnected");
    expect(simctl.commands).toEqual([]);
    expect(listed(simctl)).toContain(tv.udid);
  });

  test("a TV that is not listed is already absent, with no simctl command", async () => {
    const { simctl } = await arrange([]);

    const result = toolJson(await remove(target("00000000-0000-4000-8000-000000000000")));

    expect(result).toMatchObject({
      state: "already_absent",
      command: { stop: "not_required", destroy: "not_required" },
    });
    expect(simctl.commands).toEqual([]);
  });

  test("a stableName that does not match the TV is refused before any command", async () => {
    const tv = tvDevice({ name: NAME });
    const { simctl } = await arrange([tv]);

    const result = await remove(target(tv.udid, { stableName: "Other AppleTv" }));

    expect(result).toMatchObject({ isError: true });
    expect(toolJson(result)).toMatchObject({
      state: "failed",
      failure: { code: "identity_conflict", phase: "precondition" },
    });
    expect(simctl.commands).toEqual([]);
  });

  test("a TV started again before the teardown lease is not deleted", async () => {
    const tv = tvDevice({ name: NAME });
    const { simctl } = await arrange([tv]);
    const list = simctl.listSimulators.bind(simctl);
    let reads = 0;
    simctl.listSimulators = async () => {
      reads += 1;
      if (reads === 2) {
        tv.state = "Booted";
      }
      return await list();
    };

    const result = await remove(target(tv.udid));

    expect(toolJson(result)).toMatchObject({
      state: "failed",
      failure: { code: "tv_delete_failed" },
    });
    expect(String(toolJson(result).error)).toContain("was started again");
    expect(simctl.commands).toEqual([]);
    expect(listed(simctl)).toContain(tv.udid);
  });

  test("a TV still listed after simctl delete is a failed delete", async () => {
    const tv = tvDevice({ name: NAME });
    const { simctl } = await arrange([tv]);
    simctl.deleteSimulator = async (udid: string) => {
      simctl.commands.push(`delete ${udid}`);
    };

    const result = await remove(target(tv.udid));

    expect(toolJson(result)).toMatchObject({
      state: "failed",
      failure: { code: "tv_delete_failed", phase: "destroy" },
    });
    expect(listed(simctl)).toContain(tv.udid);
  });
});

function createdUdid(simctl: FakeAppleTvProvisionSimctl): string {
  return Object.values(simctl.listing.devices)
    .flat()
    .find((device) => device.name === NAME)!.udid;
}

/** Runs `effect` after the `count`-th TV listing read, before that read returns. */
function afterListing(simctl: FakeAppleTvProvisionSimctl, count: number, effect: () => void): void {
  const list = simctl.listSimulators.bind(simctl);
  let reads = 0;
  simctl.listSimulators = async () => {
    const listing = await list();
    reads += 1;
    if (reads === count) {
      effect();
    }
    return listing;
  };
}
