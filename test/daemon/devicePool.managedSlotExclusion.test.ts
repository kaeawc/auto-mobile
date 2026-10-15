import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  RegistryBindingExclusion,
  runAsBindingReconciler,
} from "../../src/daemon/sessionBroker/provisioning/exclusion";
import {
  DEVICE_ASSIGNED_TO_BINDING_CODE,
  BINDING_DISCOVERY_INCOMPLETE_CODE,
  DeviceAssignedToBindingError,
  BindingDiscoveryIncompleteError,
} from "../../src/daemon/sessionBroker/provisioning/refusal";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeBindingRegistry } from "../fakes/FakeBindingRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { settleWithFakeTime } from "../helpers/fakeTimerStepping";
import { asPlanAllocation } from "../helpers/planLabelAllocation";
import { assignBindingDevice } from "./sessionBroker/provisioning/bindingFixtures";

// #11174 part b / #11178 part a: a device a managed slot holds is never generic capacity, even
// while idle with no session. Every case below has no live session on the assigned device.

const ios = (deviceId: string): BootedDevice => ({ deviceId, name: deviceId, platform: "ios" });
const android = (deviceId: string): BootedDevice => ({
  deviceId,
  name: deviceId,
  platform: "android",
});

describe("DevicePool binding exclusion", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let manager: FakeDeviceManager;
  let registry: FakeBindingRegistry;
  let pool: DevicePool;

  const setUp = async (devices: BootedDevice[]) => {
    manager.bootedDevices = devices;
    pool = new DevicePool(
      createDevicePoolDependencies(sessions, "managed-slot-exclusion", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        bindingExclusion: new RegistryBindingExclusion(async () => registry, timer),
      }),
    );
    await pool.initializeWithDevices(devices);
  };

  const settle = (result: Promise<unknown>) =>
    settleWithFakeTime(
      timer,
      result.then(
        (value) => value,
        (error: unknown) => error,
      ),
      { stepMs: 1_000, maxSteps: 70, description: "allocation outcome" },
    );

  const assignOne = (sessionId: string, platform: "ios" | "android") =>
    settle(
      runWithAbortSignal(new AbortController().signal, () =>
        pool.assignDeviceToSession(sessionId, platform),
      ),
    );

  beforeEach(() => {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    manager = new FakeDeviceManager();
    registry = new FakeBindingRegistry(timer);
  });

  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  test("generic single-device allocation skips an idle device a binding holds", async () => {
    await assignBindingDevice(registry, "ios", "SIM-SLOT");
    await setUp([ios("SIM-SLOT"), ios("SIM-FREE")]);

    expect(await assignOne("generic-1", "ios")).toBe("SIM-FREE");
    const second = await assignOne("generic-2", "ios");

    expect(second).toBeInstanceOf(Error);
    expect(pool.getDevice("SIM-SLOT")?.sessionId).toBeNull();
    expect(sessions.getSession("generic-2")).toBeNull();
  });

  test("stats and the available count treat a binding device as assigned, not idle", async () => {
    await assignBindingDevice(registry, "ios", "SIM-SLOT");
    await setUp([ios("SIM-SLOT"), ios("SIM-FREE")]);
    await pool.bindingStableIds("ios");

    expect(pool.getStats()).toMatchObject({ total: 2, idle: 1, assigned: 1 });
    expect(pool.getAvailableDeviceCount()).toBe(1);
    expect(pool.getIdleDevices().map((device) => device.id)).toEqual(["SIM-FREE"]);
  });

  test("allocation timeout message does not count the binding device as idle (#11320)", async () => {
    await assignBindingDevice(registry, "ios", "SIM-SLOT");
    await setUp([ios("SIM-SLOT"), ios("SIM-FREE")]);
    await pool.bindingStableIds("ios");

    expect(await assignOne("generic-1", "ios")).toBe("SIM-FREE");
    const refused = await assignOne("generic-2", "ios");

    expect(refused).toBeInstanceOf(Error);
    const message = (refused as Error).message;
    expect(message).toContain("Total devices: 2");
    expect(message).toContain("Idle: 0\n");
    expect(message).toContain("Assigned: 2\n");
  });

  test("multi-device criteria allocation never lends the assigned device", async () => {
    await assignBindingDevice(registry, "ios", "SIM-SLOT");
    await setUp([ios("SIM-SLOT"), ios("SIM-FREE")]);

    const allocate = (sessionIds: string[]) =>
      settle(
        runWithAbortSignal(new AbortController().signal, () =>
          pool.assignMultipleDevicesByCriteria(
            sessionIds.map((sessionId) => ({ sessionId, criteria: { platform: "ios" as const } })),
            4_000,
          ),
        ),
      );

    const refused = await allocate(["a", "b"]);
    expect(refused).toBeInstanceOf(Error);
    expect(pool.getDevice("SIM-SLOT")?.sessionId).toBeNull();

    const granted = (await allocate(["c"])) as Map<string, string>;
    expect(granted.get("c")).toBe("SIM-FREE");
  });

  test("an explicit bind of the assigned idle device is refused, typed and non-retryable", async () => {
    const binding = await assignBindingDevice(registry, "ios", "SIM-SLOT");
    await setUp([ios("SIM-SLOT")]);

    const error = await pool
      .bindOrReuseDeviceSession("generic", "SIM-SLOT", "ios")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DeviceAssignedToBindingError);
    expect((error as DeviceAssignedToBindingError).toPayload()).toMatchObject({
      code: DEVICE_ASSIGNED_TO_BINDING_CODE,
      scopeKey: binding.scopeKey,
      declaredBinding: 0,
      stableId: "SIM-SLOT",
      retryable: false,
    });
    expect(pool.getDevice("SIM-SLOT")?.sessionId).toBeNull();
  });

  test.each(["SIM-SLOT", "amslot-12345678-0-g1-attempt"])(
    "the binding's own execution session may bind its device held as %s",
    async (stableId) => {
      await assignBindingDevice(registry, "ios", stableId, "runner-a", "slot-exec");
      await setUp([{ ...ios("SIM-SLOT"), name: stableId }]);

      await pool.bindOrReuseDeviceSession("slot-exec", "SIM-SLOT", "ios");

      expect(pool.getDevice("SIM-SLOT")?.sessionId).toBe("slot-exec");
    },
  );

  test("pooled iOS lifecycle gates refuse a creating binding's name but allow its reconciler", async () => {
    const name = "amslot-12345678-0-g1-attempt";
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "creating",
      runnerIncarnation: "boot-1",
    });
    if (scope.kind !== "ready") {
      throw new Error(`scope not ready: ${scope.kind}`);
    }
    const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
    await registry.initBinding(key, { role: "app", platform: "ios", requestedSpec: {} });
    expect(
      await registry.openBindingJournal(key, {
        kind: "create",
        phase: "creating",
        owner: { daemonId: "creator", pid: 1, processGenerationToken: "fake" },
        target: {
          oldStableId: null,
          oldName: null,
          newStableId: null,
          newName: name,
          requestedSpec: {},
          resolvedSpec: null,
          specFingerprint: "fp",
        },
        assignment: {
          kind: "state",
          expected: { generation: 0, stableDeviceId: null },
          state: "provisioning",
        },
      }),
    ).toMatchObject({ kind: "opened" });
    await setUp([]);
    await expect(
      pool.assertNotAssignedToBinding({
        action: "startDevice",
        deviceId: "SIM-SLOT",
        platform: "ios",
        stableIds: [name],
      }),
    ).rejects.toMatchObject({ code: DEVICE_ASSIGNED_TO_BINDING_CODE, stableId: name });
    await runAsBindingReconciler(key, () =>
      pool.assertNotAssignedToBinding({
        action: "startDevice",
        deviceId: "SIM-SLOT",
        platform: "ios",
        stableIds: [name],
      }),
    );
    await setUp([{ ...ios("SIM-SLOT"), name }]);
    for (const action of ["killDevice", "deleteDevice", "setActiveDevice"]) {
      await expect(
        pool.assertNotAssignedToBinding({ action, deviceId: "SIM-SLOT", platform: "ios" }),
      ).rejects.toMatchObject({ code: DEVICE_ASSIGNED_TO_BINDING_CODE, stableId: name });
    }
    expect(pool.getDevice("SIM-SLOT")?.sessionId).toBeNull();
  });

  test("an explicit bind names the AVD the caller resolved for a pooled serial", async () => {
    await assignBindingDevice(registry, "android", "slot-avd");
    await setUp([android("emulator-5554")]);

    const error = await pool
      .bindOrReuseDeviceSession("generic", "emulator-5554", "android", {
        name: "slot-avd",
        platform: "android",
        source: "local",
      })
      .catch((caught: unknown) => caught);

    expect((error as DeviceAssignedToBindingError).code).toBe(DEVICE_ASSIGNED_TO_BINDING_CODE);
  });

  test("auto-start never boots a stopped AVD a binding holds", async () => {
    await assignBindingDevice(registry, "android", "slot-avd");
    await setUp([android("d1")]);
    await pool.bindOrReuseDeviceSession("base", "d1", "android");
    manager.deviceImages = [
      { name: "slot-avd", platform: "android", isRunning: false },
      { name: "spare-avd", platform: "android", isRunning: false },
    ];

    const result = (await settle(
      runWithAbortSignal(new AbortController().signal, () =>
        asPlanAllocation(sessions, "base", ["base:B"], () =>
          pool.assignMultipleDevicesByCriteria(
            ["base", "base:B"].map((sessionId) => ({
              sessionId,
              criteria: { platform: "android" as const },
            })),
            4_000,
          ),
        ),
      ),
    )) as Map<string, string>;

    expect(manager.startedDevices.map((device) => device.name)).toEqual(["spare-avd"]);
    expect(result.get("base:B")).toBe("spare-avd");
  });

  test("a registry that was never readable refuses allocation instead of treating devices as free", async () => {
    await setUp([ios("SIM-FREE")]);
    registry.snapshotManagedDevices = async () => {
      throw new Error("disk I/O error");
    };

    const error = await assignOne("generic", "ios");

    expect(error).toBeInstanceOf(BindingDiscoveryIncompleteError);
    expect(pool.getDevice("SIM-FREE")?.sessionId).toBeNull();
  });
  const failAfterSnapshot = async () => {
    await pool.bindingStableIds("ios");
    registry.snapshotManagedDevices = async () => {
      throw new Error("locked");
    };
  };

  test("PIN: a never-read failing registry admits an existing holder and refuses an unheld target", async () => {
    await setUp([ios("SIM-HELD"), ios("SIM-FREE")]);
    await sessions.createSession("existing", "SIM-HELD", "ios");
    // Seed control that predates registry discovery without taking a device through its gate.
    const held = pool.getDevice("SIM-HELD")!;
    held.sessionId = "existing";
    held.status = "assigned";
    registry.snapshotManagedDevices = async () => {
      throw new Error("registry never readable");
    };
    await expect(
      pool.assertNotAssignedToBinding({
        action: "tapOn",
        deviceId: "SIM-HELD",
        platform: "ios",
        requesterSessionUuid: "existing",
      }),
    ).resolves.toBeUndefined();
    await expect(
      pool.assertNotAssignedToBinding({
        action: "tapOn",
        deviceId: "SIM-FREE",
        platform: "ios",
      }),
    ).rejects.toMatchObject({ code: BINDING_DISCOVERY_INCOMPLETE_CODE, retryable: true });
    expect(pool.getDevice("SIM-HELD")?.sessionId).toBe("existing");
    expect(pool.getDevice("SIM-FREE")?.sessionId).toBeNull();
  });

  test("a plain caller cannot take a device absent from the retained snapshot", async () => {
    await setUp([ios("SIM-FREE")]);
    await failAfterSnapshot();
    await expect(pool.bindOrReuseDeviceSession("plain", "SIM-FREE", "ios")).rejects.toMatchObject({
      code: BINDING_DISCOVERY_INCOMPLETE_CODE,
      retryable: true,
    });
    expect(pool.getDevice("SIM-FREE")?.sessionId).toBeNull();
  });

  test("generic allocation refuses retryably after a previously good registry read fails", async () => {
    await setUp([ios("SIM-FREE")]);
    await failAfterSnapshot();
    expect(await assignOne("generic", "ios")).toMatchObject({
      code: BINDING_DISCOVERY_INCOMPLETE_CODE,
      retryable: true,
    });
    expect(pool.getDevice("SIM-FREE")?.sessionId).toBeNull();
  });

  test("retained known devices still refuse plain callers and admit their execution and reconciler", async () => {
    const binding = await assignBindingDevice(registry, "ios", "SIM-SLOT", "runner", "exec");
    await setUp([ios("SIM-SLOT")]);
    await failAfterSnapshot();
    const input = { action: "tapOn", deviceId: "SIM-SLOT", platform: "ios" as const };
    await expect(pool.assertNotAssignedToBinding(input)).rejects.toMatchObject({
      code: DEVICE_ASSIGNED_TO_BINDING_CODE,
    });
    await pool.assertNotAssignedToBinding({ ...input, requesterSessionUuid: "exec" });
    await runAsBindingReconciler(binding, () => pool.assertNotAssignedToBinding(input));
    await expect(
      runAsBindingReconciler({ scopeKey: "peer", bindingIndex: 0 }, () =>
        pool.assertNotAssignedToBinding(input),
      ),
    ).rejects.toMatchObject({ code: DEVICE_ASSIGNED_TO_BINDING_CODE });
  });

  test("a retained refusal for a nonholding session retries until a current read proves assignment", async () => {
    await assignBindingDevice(registry, "ios", "SIM-SLOT", "runner", "exec");
    await setUp([ios("SIM-SLOT")]);
    const readable = registry.snapshotManagedDevices.bind(registry);
    await failAfterSnapshot();
    const input = {
      action: "tapOn",
      deviceId: "SIM-SLOT",
      platform: "ios" as const,
      requesterSessionUuid: "other",
    };
    await expect(pool.assertNotAssignedToBinding(input)).rejects.toMatchObject({
      code: "discovery_incomplete",
      retryable: true,
      retryAfterMs: 2_000,
    });
    registry.snapshotManagedDevices = readable;
    await expect(pool.assertNotAssignedToBinding(input)).rejects.toMatchObject({
      code: "device_assigned_to_binding",
      retryable: false,
    });
  });

  test("a current registry naming another execution refuses even the session held by this pool", async () => {
    await assignBindingDevice(registry, "ios", "SIM-SLOT", "runner", "peer");
    await setUp([ios("SIM-SLOT")]);
    const held = pool.getDevice("SIM-SLOT")!;
    held.sessionId = "local";
    held.status = "assigned";
    await expect(
      pool.assertNotAssignedToBinding({
        action: "tapOn",
        deviceId: "SIM-SLOT",
        platform: "ios",
        requesterSessionUuid: "local",
      }),
    ).rejects.toMatchObject({ code: "device_assigned_to_binding", retryable: false });
  });

  test("an existing unmanaged holder keeps control and inventory remains available", async () => {
    await setUp([ios("SIM-FREE")]);
    await pool.bindOrReuseDeviceSession("existing", "SIM-FREE", "ios");
    await failAfterSnapshot();
    await pool.assertNotAssignedToBinding({
      action: "tapOn",
      deviceId: "SIM-FREE",
      platform: "ios",
      requesterSessionUuid: "existing",
    });
    await expect(pool.refreshInventoryOwnership()).resolves.toBeUndefined();
    expect(pool.getDevice("SIM-FREE")?.sessionId).toBe("existing");
  });

  test("a peer reconciler cannot take an absent device during a registry outage", async () => {
    await setUp([ios("SIM-FREE")]);
    await failAfterSnapshot();
    await expect(
      runAsBindingReconciler({ scopeKey: "peer", bindingIndex: 0 }, () =>
        pool.assertNotAssignedToBinding({
          action: "startDevice",
          deviceId: "SIM-FREE",
          platform: "ios",
        }),
      ),
    ).rejects.toMatchObject({ code: BINDING_DISCOVERY_INCOMPLETE_CODE, retryable: true });
  });
});
