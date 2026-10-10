import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { cancelExecutionsCutBySessionRelease } from "../../src/daemon/releaseSessionAndDevice";
import { sessionReleaseThatCancelledCall } from "../../src/daemon/sessionReleasedDuringCall";
import { hasActiveSessionExecution } from "../../src/daemon/toolCallActivity";
import { resolveToolSelectionBaseSessionUuid } from "../../src/features/toolSelection/selectionSessionResolver";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../src/models";
import { buildDeviceLabelMap } from "../../src/server/deviceLabelMapping";
import { executionTracker, type ActiveExecution } from "../../src/server/executionTracker";
import { DefaultPlanLifecycleManager } from "../../src/server/toolRegistry";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// #11490: a plan's auto-release (its base session, and each derived `${base}:${label}` session)
// must cut every other call still running under the session BEFORE the pool frees the device,
// as every other release does (#11429, #11447). `input/*` frames carry no plan lock and reads
// are exempt from it, so both can be in flight when the plan ends. A `plan-auto-release` UUID is
// re-issuable by name, so the cut is the plain cancellation, never the terminal refusal.

const devices: BootedDevice[] = [
  { name: "Pixel A", deviceId: "device-A", platform: "android" },
  { name: "Pixel B", deviceId: "device-B", platform: "android" },
];

describe("plan auto-release with other calls in flight (#11490)", () => {
  let manager: SessionManager;
  let pool: DevicePool;
  /** Per freed device: which of the named executions were already aborted when it was freed. */
  let abortedWhenFreed: Map<string, Record<string, boolean>>;
  let watched: Map<string, ActiveExecution>;
  const started: string[] = [];
  const restores: Array<() => void> = [];
  const lifecycle = new DefaultPlanLifecycleManager();

  beforeEach(async () => {
    const timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const deviceManager = new FakeDeviceUtils();
    deviceManager.setBootedDevices("android", devices);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "daemon-session", {
        timer,
        deviceManager,
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices(devices);
    DaemonState.getInstance().initialize(manager, pool);
    // The daemon's wiring of the session manager's own cut routine (daemon.ts), to show the
    // plan path is cut whether or not that routine is involved.
    manager.setActiveSessionExecutionChecker((id, query) =>
      hasActiveSessionExecution(executionTracker, manager, pool, id, query),
    );
    manager.setExpiryReleaseExecutionCanceller((id, cancellation, query, deviceId) => {
      void cancelExecutionsCutBySessionRelease(
        executionTracker,
        {
          sessionId: id,
          baseSessionId: resolveToolSelectionBaseSessionUuid(id, manager),
          deviceId,
          excludeExecutionId: query.excludeExecutionId,
        },
        cancellation,
      );
    });
    abortedWhenFreed = new Map();
    watched = new Map();
    const free = spyOn(pool, "releaseDevice").mockImplementation(async (deviceId) => {
      abortedWhenFreed.set(
        deviceId,
        Object.fromEntries(
          [...watched].map(([name, execution]) => [name, execution.abortController.signal.aborted]),
        ),
      );
    });
    restores.push(() => free.mockRestore());
  });

  afterEach(() => {
    for (const id of started.splice(0)) {
      executionTracker.endExecution(id);
    }
    for (const restore of restores.splice(0)) {
      restore();
    }
    executionTracker.setAutolockSessionResolver({ autolockSessionForMcpSession: () => undefined });
    manager.stopCleanupTimer();
    DaemonState.getInstance().reset();
  });

  const acquire = async (labels: string[] = ["A"]): Promise<void> => {
    const map = buildDeviceLabelMap(labels, "base");
    for (const [i, label] of labels.entries()) {
      await manager.createSession(map[label], devices[i].deviceId, "android");
    }
    if (labels.length > 1) {
      manager.setDeviceLabels("base", map);
    }
  };

  const track = (name: string, execution: ActiveExecution): ActiveExecution => {
    started.push(execution.id);
    watched.set(name, execution);
    return execution;
  };

  /** What `SocketServer.runTrackedDeviceInput` registers for an admitted `input/*` frame. */
  const controlCall = (name: string, sessionUuid: string, deviceId: string): ActiveExecution => {
    const execution = executionTracker.startExecution("input/tap", undefined, sessionUuid);
    executionTracker.bindDeviceExecution(execution.id, deviceId);
    executionTracker.markDeviceControlCall(execution.id);
    executionTracker.markSessionAdmitted(execution.id);
    return track(name, execution);
  };

  /** The plan's own call: tracked under the base session and bound to every plan device. */
  const planCall = (deviceIds: string[] = ["device-A"]): ActiveExecution => {
    const execution = executionTracker.startExecution("executePlan", "conn-plan", "base");
    for (const deviceId of deviceIds) {
      executionTracker.bindDeviceExecution(execution.id, deviceId);
    }
    return track("plan", execution);
  };

  /** Run the plan's end-of-call lifecycle as the device-aware wrapper does: under its own call. */
  const finishPlan = (plan: ActiveExecution): Promise<void> =>
    runWithToolSelectionContext(
      { execution: { executionId: plan.id, startTime: plan.startTime } },
      () =>
        lifecycle.afterExecution({
          name: "executePlan",
          args: {},
          baseSessionUuid: "base",
          sessionUuid: "base",
          device: devices[0],
          shouldResolveDevice: true,
        }),
    );

  const expectPlainCancellation = (execution: ActiveExecution): void => {
    expect(execution.abortController.signal.aborted).toBe(true);
    // Not the terminal refusal: the UUID is re-issuable, so nothing may call it gone for good.
    expect(sessionReleaseThatCancelledCall(execution.cancelReason)).toBeUndefined();
    expect(
      sessionReleaseThatCancelledCall(execution.abortController.signal.reason),
    ).toBeUndefined();
  };

  test("a control call under the base session is cut before the pool frees the device", async () => {
    await acquire();
    const plan = planCall();
    const call = controlCall("control", "base", "device-A");

    await finishPlan(plan);

    expect(manager.getSession("base")).toBeNull();
    expect(abortedWhenFreed.get("device-A")).toEqual({ plan: false, control: true });
    expectPlainCancellation(call);
  });

  test("a call under a derived label session, and a base call on its device, are cut before it is freed", async () => {
    await acquire(["A", "B"]);
    const plan = planCall(["device-A", "device-B"]);
    const onDerived = controlCall("derived", "base:B", "device-B");
    const baseOnDerivedDevice = controlCall("baseOnB", "base", "device-B");

    await finishPlan(plan);

    expect(manager.getSession("base:B")).toBeNull();
    expect(manager.getSession("base")).toBeNull();
    expect(abortedWhenFreed.get("device-B")).toEqual({ plan: false, derived: true, baseOnB: true });
    expect(abortedWhenFreed.get("device-A")).toEqual({ plan: false, derived: true, baseOnB: true });
    expectPlainCancellation(onDerived);
    expectPlainCancellation(baseOnDerivedDevice);
  });

  test("the plan's own call is never cut, though it runs under the base and is bound to every device", async () => {
    await acquire(["A", "B"]);
    const plan = planCall(["device-A", "device-B"]);

    await finishPlan(plan);

    expect(plan.abortController.signal.aborted).toBe(false);
    expect(plan.revokedDeviceBindings).toBeUndefined();
    expect(abortedWhenFreed.get("device-A")).toEqual({ plan: false });
    expect(abortedWhenFreed.get("device-B")).toEqual({ plan: false });
  });

  test("a read in flight is cancelled cleanly rather than left running on the freed device", async () => {
    await acquire();
    const plan = planCall();
    const read = executionTracker.startExecution("observe", "conn-reader", "base");
    executionTracker.bindDeviceExecution(read.id, "device-A");
    executionTracker.markDeviceReadCall(read.id, "observe");
    track("read", read);

    await finishPlan(plan);

    expect(abortedWhenFreed.get("device-A")).toEqual({ plan: false, read: true });
    expectPlainCancellation(read);
  });

  test("an implicit (autolock) call that reached the session is cut too", async () => {
    await acquire();
    executionTracker.setAutolockSessionResolver({ autolockSessionForMcpSession: () => "base" });
    const plan = planCall();
    const implicit = track("implicit", executionTracker.startExecution("tapOn", "conn-implicit"));
    executionTracker.setResolvedAutolockSessionUuid(implicit.id, "base");

    await finishPlan(plan);

    expect(abortedWhenFreed.get("device-A")).toEqual({ plan: false, implicit: true });
    expectPlainCancellation(implicit);
  });

  test("a call on another session is not cut", async () => {
    await acquire();
    await manager.createSession("other", "device-B", "android");
    const plan = planCall();
    const elsewhere = controlCall("elsewhere", "other", "device-B");

    await finishPlan(plan);

    expect(manager.getSession("base")).toBeNull();
    expect(elsewhere.abortController.signal.aborted).toBe(false);
    expect(manager.getSession("other")).not.toBeNull();
  });

  test("a managed slot session survives the plan and its calls are not cut", async () => {
    await acquire();
    DaemonState.getInstance()
      .getManagedConnectionScopes()
      .bind("conn-managed", { scopeKey: "scope-1", sessionUuids: ["base"] });
    const plan = planCall();
    const call = controlCall("control", "base", "device-A");

    await finishPlan(plan);

    expect(manager.getSession("base")?.assignedDevice).toBe("device-A");
    expect(abortedWhenFreed.size).toBe(0);
    expect(call.abortController.signal.aborted).toBe(false);
  });

  test("the UUID is not fenced: it is issued again by name and a second plan under it releases the same way", async () => {
    await acquire();
    const firstPlan = planCall();
    const firstCall = controlCall("first", "base", "device-A");
    await finishPlan(firstPlan);
    expectPlainCancellation(firstCall);
    executionTracker.endExecution(firstPlan.id);
    executionTracker.endExecution(firstCall.id);
    watched.clear();
    abortedWhenFreed.clear();

    expect(manager.getTerminalReleaseSnapshot("base")).toBeUndefined();
    await manager.createSession("base", "device-A", "android");
    expect(manager.getSession("base")?.assignedDevice).toBe("device-A");
    // A call admitted under the re-issued session is not touched by the earlier release.
    const secondPlan = planCall();
    const secondCall = controlCall("second", "base", "device-A");
    expect(secondCall.abortController.signal.aborted).toBe(false);

    await finishPlan(secondPlan);

    expect(manager.getSession("base")).toBeNull();
    expect(abortedWhenFreed.get("device-A")).toEqual({ plan: false, second: true });
    expect(secondPlan.abortController.signal.aborted).toBe(false);
    expectPlainCancellation(secondCall);
  });
});
