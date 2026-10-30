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
import { WatchSimulatorInventory } from "../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import { WatchSimulatorLifecycle } from "../../src/utils/ios-cmdline-tools/WatchSimulatorLifecycle";
import { WatchSimulatorProvisioner } from "../../src/utils/ios-cmdline-tools/WatchSimulatorProvisioner";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
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

// deleteDevice on an Apple Watch simulator applies killDevice's caller checks, stops a running
// watch, deletes it with simctl and proves it gone from a fresh watch listing (#15882).

const NAME = "AutoMobile Watch";
const SPEC = { deviceType: WATCH_DEVICE_TYPE.identifier, runtime: WATCH_RUNTIME_ID };
const WATCH = { platform: "watchos", name: NAME, spec: SPEC };
const sessionSchema = z.object({ sessionId: z.string() });

describe("deleteDevice on an Apple Watch simulator", () => {
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
    // killDevice's platform kill for a watch is simctl shutdown, which the listing then reflects.
    deviceUtils.killDevice = async (device) => {
      await new WatchSimulatorLifecycle(simctl, inventory).shutdown(device);
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
    await pool.initializeWithDevices(await deviceUtils.getBootedDevices("watchos"));
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
        throw new Error("a watch provision must never prepare an automation runner");
      },
      watchSimulatorLifecycleFactory: () => new WatchSimulatorLifecycle(simctl, inventory),
      watchSimulatorProvisionerFactory: () => new WatchSimulatorProvisioner(inventory, simctl),
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
    target: { platform: "watchos", isVirtual: true, stableId: udid, ...extra },
  });

  const listed = (simctl: FakeWatchProvisionSimctl) =>
    Object.values(simctl.listing.devices)
      .flat()
      .map((device) => device.udid);

  test("deletes a stopped watch and confirms it absent from a fresh listing", async () => {
    const watch = watchDevice({ name: NAME });
    const { simctl } = await arrange([watch]);

    const result = toolJson(await remove(target(watch.udid)));

    expect(result).toMatchObject({
      state: "destroyed",
      target: { platform: "watchos", stableId: watch.udid },
      command: { stop: "not_required", destroy: "accepted" },
      verification: { notRunning: "confirmed", inventory: "complete_absence_confirmed" },
    });
    expect(simctl.commands).toEqual([`delete ${watch.udid}`]);
    expect(listed(simctl)).not.toContain(watch.udid);
  });

  test("the holding session stops its running watch, releasing the session, then deletes it", async () => {
    const { simctl, pool, sessions, timer } = await arrange();
    const { sessionId } = sessionSchema.parse(toolJson(await provision({ device: WATCH })));
    const udid = createdUdid(simctl);
    simctl.commands.length = 0;

    const result = toolJson(
      await settleByFakeEvents(timer, remove({ ...target(udid), sessionUuid: sessionId }), {
        description: "deleteDevice of a running watch",
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

  test("a watch another connection's session holds is refused, and nothing is stopped or deleted", async () => {
    const { simctl } = await arrange();
    await provision({ device: WATCH });
    const udid = createdUdid(simctl);
    simctl.commands.length = 0;

    const error = await failure(remove(target(udid), "client-b"));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("deleteDevice");
    expect(simctl.commands).toEqual([]);
    expect(listed(simctl)).toContain(udid);
  });

  test("an externally stopped watch its session still holds is released, then deleted", async () => {
    const { simctl, pool, sessions } = await arrange();
    const { sessionId } = sessionSchema.parse(toolJson(await provision({ device: WATCH })));
    const udid = createdUdid(simctl);
    await simctl.killSimulator({ name: NAME, platform: "watchos", deviceId: udid });
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
    const watch = watchDevice({ name: NAME });
    const { simctl, timer } = await arrange([watch]);
    afterListing(simctl, 1, () => timer.advanceTime(50));

    const result = await remove({ ...target(watch.udid), timeoutMs: 10 });

    expect(toolJson(result)).toMatchObject({
      state: "failed",
      failure: { code: "teardown_deadline_exceeded" },
    });
    expect(simctl.commands).toEqual([]);
    expect(listed(simctl)).toContain(watch.udid);
  });

  test("an accepted delete continues after its caller goes away", async () => {
    const watch = watchDevice({ name: NAME });
    const { simctl } = await arrange([watch]);
    const caller = new AbortController();
    afterListing(simctl, 1, () => caller.abort(new Error("client disconnected")));

    const result = toolJson(
      await ToolRegistry.getTool("deleteDevice")!.handler(
        { __mcpSessionId: "client-a", mode: "destroy", verifyAbsence: true, ...target(watch.udid) },
        undefined,
        caller.signal,
      ),
    );

    expect(result).toMatchObject({ state: "destroyed" });
    expect(listed(simctl)).not.toContain(watch.udid);
  });

  test("cancel-on-request-abort stops the delete when its caller goes away", async () => {
    const watch = watchDevice({ name: NAME });
    const { simctl } = await arrange([watch]);
    const caller = new AbortController();
    afterListing(simctl, 1, () => caller.abort(new Error("client disconnected")));

    const outcome = await failure(
      ToolRegistry.getTool("deleteDevice")!.handler(
        {
          __mcpSessionId: "client-a",
          mode: "destroy",
          verifyAbsence: true,
          cancellationPolicy: "cancel-on-request-abort",
          ...target(watch.udid),
        },
        undefined,
        caller.signal,
      ),
    );

    expect(String(outcome)).toContain("client disconnected");
    expect(simctl.commands).toEqual([]);
    expect(listed(simctl)).toContain(watch.udid);
  });

  test("a watch that is not listed is already absent, with no simctl command", async () => {
    const { simctl } = await arrange([]);

    const result = toolJson(await remove(target("00000000-0000-4000-8000-000000000000")));

    expect(result).toMatchObject({
      state: "already_absent",
      command: { stop: "not_required", destroy: "not_required" },
    });
    expect(simctl.commands).toEqual([]);
  });

  test("a stableName that does not match the watch is refused before any command", async () => {
    const watch = watchDevice({ name: NAME });
    const { simctl } = await arrange([watch]);

    const result = await remove(target(watch.udid, { stableName: "Other Watch" }));

    expect(result).toMatchObject({ isError: true });
    expect(toolJson(result)).toMatchObject({
      state: "failed",
      failure: { code: "identity_conflict", phase: "precondition" },
    });
    expect(simctl.commands).toEqual([]);
  });

  test("a watch started again before the teardown lease is not deleted", async () => {
    const watch = watchDevice({ name: NAME });
    const { simctl } = await arrange([watch]);
    const list = simctl.listSimulators.bind(simctl);
    let reads = 0;
    simctl.listSimulators = async () => {
      reads += 1;
      if (reads === 2) {
        watch.state = "Booted";
      }
      return await list();
    };

    const result = await remove(target(watch.udid));

    expect(toolJson(result)).toMatchObject({
      state: "failed",
      failure: { code: "watch_delete_failed" },
    });
    expect(String(toolJson(result).error)).toContain("was started again");
    expect(simctl.commands).toEqual([]);
    expect(listed(simctl)).toContain(watch.udid);
  });

  test("a watch still listed after simctl delete is a failed delete", async () => {
    const watch = watchDevice({ name: NAME });
    const { simctl } = await arrange([watch]);
    simctl.deleteSimulator = async (udid: string) => {
      simctl.commands.push(`delete ${udid}`);
    };

    const result = await remove(target(watch.udid));

    expect(toolJson(result)).toMatchObject({
      state: "failed",
      failure: { code: "watch_delete_failed", phase: "destroy" },
    });
    expect(listed(simctl)).toContain(watch.udid);
  });
});

function createdUdid(simctl: FakeWatchProvisionSimctl): string {
  return Object.values(simctl.listing.devices)
    .flat()
    .find((device) => device.name === NAME)!.udid;
}

/** Runs `effect` after the `count`-th watch listing read, before that read returns. */
function afterListing(simctl: FakeWatchProvisionSimctl, count: number, effect: () => void): void {
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
