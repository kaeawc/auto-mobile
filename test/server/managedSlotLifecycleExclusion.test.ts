import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { assertInputNotOnForeignBindingDevice } from "../../src/daemon/inputDeviceOwnership";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { RegistryBindingExclusion } from "../../src/daemon/sessionBroker/provisioning/exclusion";
import {
  DEVICE_ASSIGNED_TO_BINDING_CODE,
  DeviceAssignedToBindingError,
} from "../../src/daemon/sessionBroker/provisioning/refusal";
import type { BindingKey } from "../../src/daemon/sessionBroker/registry/bindingRegistry";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice } from "../../src/models";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeBindingRegistry } from "../fakes/FakeBindingRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { assignBindingDevice } from "../daemon/sessionBroker/provisioning/bindingFixtures";

/** Records each platform kill and stops there, so an admitted call proves only that it got past the gate. */
class RecordingKillDeviceManager extends FakeDeviceUtils {
  readonly killed: string[] = [];

  override async killDevice(device: BootedDevice): Promise<void> {
    this.killed.push(device.deviceId);
    throw new Error("platform kill reached");
  }
}

/**
 * Cross-slot denial with no active session (#11174 part b, #11178 part a): the slot's device is
 * idle, so the session-holder checks see an unheld device and would let anyone stop, delete or
 * drive it. The managed-slot gate refuses every caller but the slot's own execution; `force` does
 * not override it.
 */
describe("binding lifecycle and input exclusion", () => {
  const slotDevice: BootedDevice = { name: "iPhone Slot", deviceId: "IOS-SLOT", platform: "ios" };
  const freeDevice: BootedDevice = { name: "iPhone Free", deviceId: "IOS-FREE", platform: "ios" };
  const exec = "slot-exec";

  let manager: RecordingKillDeviceManager;
  let sessionManager: SessionManager;
  let registry: FakeBindingRegistry;
  let binding: BindingKey;
  let lifecycleCoordinator: InMemoryVirtualDeviceLifecycleCoordinator;

  const tool = (name: string) => ToolRegistry.getTool(name)!.handler;

  async function kill(args: Record<string, unknown>, routingSessionUuid?: string) {
    try {
      await runWithToolSelectionContext({ routingSessionUuid }, () => tool("killDevice")(args));
    } catch (error) {
      return error;
    }
    return undefined;
  }

  const deleteArgs = (force?: boolean) => ({
    target: { platform: "ios", isVirtual: true, stableId: slotDevice.deviceId },
    mode: "destroy",
    verifyAbsence: true,
    timeoutMs: 60_000,
    ...(force === undefined ? {} : { force }),
  });

  beforeEach(async () => {
    ToolRegistry.clearTools();
    const timer = new FakeTimer();
    manager = new RecordingKillDeviceManager();
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: { listRecordings: async () => [] } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer,
      now: () => new Date(0),
    });
    manager.setBootedDevices("ios", [slotDevice, freeDevice]);
    lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    setDeviceToolsDependencies({
      lifecycleCoordinator,
      deviceManagerFactory: () => manager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    registry = new FakeBindingRegistry(timer);
    binding = await assignBindingDevice(registry, "ios", slotDevice.deviceId, "runner-a", exec);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "managed-slot-lifecycle", {
        timer,
        deviceManager: manager,
        bindingExclusion: new RegistryBindingExclusion(async () => registry, timer),
      }),
    );
    await pool.initializeWithDevices([slotDevice, freeDevice]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    await sessionManager.createSession("other-session", freeDevice.deviceId, "ios");
    registerDeviceTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetDeviceToolsDependencies();
    resetVideoRecordingManagerDependencies();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  test("killDevice of an idle binding device is refused for sessionless, other-session and forced callers", async () => {
    expect(sessionManager.getSessionForDevice(slotDevice.deviceId)).toBeNull();
    for (const [args, routing] of [
      [{ device: slotDevice }, undefined],
      [{ device: slotDevice }, "other-session"],
      [{ device: slotDevice, force: true }, "other-session"],
      [{ device: slotDevice, force: true }, undefined],
    ] as const) {
      const error = await kill(args, routing);
      expect(error).toBeInstanceOf(DeviceAssignedToBindingError);
      expect(
        JSON.parse(
          shapeToolCallError(error, { toolName: "killDevice", source: "MCP" }).content[0].text,
        ),
      ).toMatchObject({
        success: false,
        code: DEVICE_ASSIGNED_TO_BINDING_CODE,
        deviceId: slotDevice.deviceId,
        scopeKey: binding.scopeKey,
        declaredBinding: 0,
        retryable: false,
      });
    }
    expect(manager.killed).toEqual([]);
  });

  test("the binding's execution session reaches the platform kill; unassigned devices are unaffected", async () => {
    expect(String(await kill({ device: slotDevice }, exec))).toContain("platform kill reached");
    await sessionManager.releaseSession("other-session", "explicit-release");
    expect(String(await kill({ device: freeDevice }))).toContain("platform kill reached");

    expect(manager.killed).toEqual([slotDevice.deviceId, freeDevice.deviceId]);
  });

  test("deleteDevice of the binding device fails its precondition with binding evidence, force or not", async () => {
    for (const force of [undefined, true]) {
      const response = (await tool("deleteDevice")(deleteArgs(force))) as {
        content: Array<{ text: string }>;
      };
      const body = JSON.parse(response.content[0].text) as Record<string, unknown>;
      expect(body).toMatchObject({
        success: false,
        state: "failed",
        failure: {
          code: DEVICE_ASSIGNED_TO_BINDING_CODE,
          phase: "precondition",
          scopeKey: binding.scopeKey,
          declaredBinding: 0,
          stableId: slotDevice.deviceId,
          retryable: false,
        },
      });
    }
    expect(manager.killed).toEqual([]);
    expect(manager.wasMethodCalled("destroyDevice")).toBe(false);
  });

  test("a refused deleteDevice does not preempt the binding acquisition preparing the device (#11271)", async () => {
    // The managed acquisition booting the slot device holds its lifecycle lease.
    const acquisition = await lifecycleCoordinator.reserve(
      { kind: "stable", platform: "ios", stableId: slotDevice.deviceId },
      { operation: "start", deadlineMs: 60_000 },
    );

    const pending = tool("deleteDevice")(deleteArgs()) as Promise<{
      content: Array<{ text: string }>;
    }>;
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    for (let i = 0; i < 20 && !settled; i++) {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Refused before reserving the teardown lease: the acquisition keeps running.
    expect(acquisition.signal.aborted).toBe(false);
    acquisition.release();
    const body = JSON.parse((await pending).content[0].text) as Record<string, unknown>;
    expect(body).toMatchObject({
      success: false,
      failure: { code: DEVICE_ASSIGNED_TO_BINDING_CODE, phase: "precondition" },
    });
    expect(settled).toBe(true);
  });

  test("a deleteDevice refused for a device another session holds does not preempt the lease holder (#11274)", async () => {
    // freeDevice is held by "other-session"; a sessionless caller is refused, and must be
    // refused before it reserves the teardown lease (reserving aborts the current lease holder).
    const inFlight = await lifecycleCoordinator.reserve(
      { kind: "stable", platform: "ios", stableId: freeDevice.deviceId },
      { operation: "start", deadlineMs: 60_000 },
    );

    const pending = tool("deleteDevice")({
      ...deleteArgs(),
      target: { platform: "ios", isVirtual: true, stableId: freeDevice.deviceId },
    }) as Promise<{ content: Array<{ text: string }> }>;
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    for (let i = 0; i < 20 && !settled; i++) {
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(inFlight.signal.aborted).toBe(false);
    inFlight.release();
    const body = JSON.parse((await pending).content[0].text) as Record<string, unknown>;
    expect(body).toMatchObject({
      success: false,
      failure: { code: "device_owned_by_other_session", phase: "precondition" },
    });
    expect(settled).toBe(true);
    expect(manager.wasMethodCalled("destroyDevice")).toBe(false);
  });

  test("getApple of a stopped binding simulator is refused before any boot or bind", async () => {
    await assignBindingDevice(registry, "ios", "IOS-STOPPED", "runner-b");
    manager.setDeviceImages("ios", [
      { name: "iPhone Stopped", platform: "ios", deviceId: "IOS-STOPPED", isRunning: false },
    ]);

    const error = await tool("getApple")({ udid: "IOS-STOPPED" }).catch(
      (caught: unknown) => caught,
    );

    expect((error as DeviceAssignedToBindingError).code).toBe(DEVICE_ASSIGNED_TO_BINDING_CODE);
    expect(manager.wasMethodCalled("startDevice")).toBe(false);
    expect(sessionManager.getSessionForDevice("IOS-STOPPED")).toBeNull();
  });

  test("input frames to an idle binding device are refused except from the binding's execution", async () => {
    const send = (requesterSessionUuid: string | undefined) =>
      assertInputNotOnForeignBindingDevice({
        action: "input/tap",
        deviceId: slotDevice.deviceId,
        platform: "ios",
        requesterSessionUuid,
        sessionManager,
        gate: DaemonState.getInstance().getDevicePool(),
      });

    for (const requester of [undefined, "other-session"]) {
      const error = await send(requester).catch((caught: unknown) => caught);
      expect((error as DeviceAssignedToBindingError).code).toBe(DEVICE_ASSIGNED_TO_BINDING_CODE);
    }
    await send(exec);
    await assertInputNotOnForeignBindingDevice({
      action: "input/tap",
      deviceId: freeDevice.deviceId,
      platform: "ios",
      requesterSessionUuid: undefined,
      sessionManager,
      gate: DaemonState.getInstance().getDevicePool(),
    });
  });
});
