import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { assertInputNotOnForeignManagedSlotDevice } from "../../src/daemon/inputDeviceOwnership";
import { RegistryManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import {
  DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE,
  DeviceAssignedToManagedSlotError,
} from "../../src/daemon/managedSlots/managedSlotRefusal";
import type { SlotKey } from "../../src/daemon/managedSlots/slotRegistry";
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
import { FakeSlotRegistry } from "../fakes/FakeSlotRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { assignManagedSlotDevice } from "../daemon/managedSlots/managedSlotFixtures";

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
describe("managed-slot lifecycle and input exclusion", () => {
  const slotDevice: BootedDevice = { name: "iPhone Slot", deviceId: "IOS-SLOT", platform: "ios" };
  const freeDevice: BootedDevice = { name: "iPhone Free", deviceId: "IOS-FREE", platform: "ios" };
  const exec = "slot-exec";

  let manager: RecordingKillDeviceManager;
  let sessionManager: SessionManager;
  let registry: FakeSlotRegistry;
  let slot: SlotKey;

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
    setDeviceToolsDependencies({
      deviceManagerFactory: () => manager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    registry = new FakeSlotRegistry(timer);
    slot = await assignManagedSlotDevice(registry, "ios", slotDevice.deviceId, "runner-a", exec);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "managed-slot-lifecycle", {
        timer,
        deviceManager: manager,
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, timer),
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

  test("killDevice of an idle slot device is refused for sessionless, other-session and forced callers", async () => {
    expect(sessionManager.getSessionForDevice(slotDevice.deviceId)).toBeNull();
    for (const [args, routing] of [
      [{ device: slotDevice }, undefined],
      [{ device: slotDevice }, "other-session"],
      [{ device: slotDevice, force: true }, "other-session"],
      [{ device: slotDevice, force: true }, undefined],
    ] as const) {
      const error = await kill(args, routing);
      expect(error).toBeInstanceOf(DeviceAssignedToManagedSlotError);
      expect(
        JSON.parse(
          shapeToolCallError(error, { toolName: "killDevice", source: "MCP" }).content[0].text,
        ),
      ).toMatchObject({
        success: false,
        code: DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE,
        deviceId: slotDevice.deviceId,
        scopeKey: slot.scopeKey,
        declaredSlot: 0,
        retryable: false,
      });
    }
    expect(manager.killed).toEqual([]);
  });

  test("the slot's execution session reaches the platform kill; unassigned devices are unaffected", async () => {
    expect(String(await kill({ device: slotDevice }, exec))).toContain("platform kill reached");
    await sessionManager.releaseSession("other-session", "explicit-release");
    expect(String(await kill({ device: freeDevice }))).toContain("platform kill reached");

    expect(manager.killed).toEqual([slotDevice.deviceId, freeDevice.deviceId]);
  });

  test("deleteDevice of the slot device fails its precondition with slot evidence, force or not", async () => {
    for (const force of [undefined, true]) {
      const response = (await tool("deleteDevice")(deleteArgs(force))) as {
        content: Array<{ text: string }>;
      };
      const body = JSON.parse(response.content[0].text) as Record<string, unknown>;
      expect(body).toMatchObject({
        success: false,
        state: "failed",
        failure: {
          code: DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE,
          phase: "precondition",
          scopeKey: slot.scopeKey,
          declaredSlot: 0,
          stableId: slotDevice.deviceId,
          retryable: false,
        },
      });
    }
    expect(manager.killed).toEqual([]);
    expect(manager.wasMethodCalled("destroyDevice")).toBe(false);
  });

  test("getApple of a stopped slot simulator is refused before any boot or bind", async () => {
    await assignManagedSlotDevice(registry, "ios", "IOS-STOPPED", "runner-b");
    manager.setDeviceImages("ios", [
      { name: "iPhone Stopped", platform: "ios", deviceId: "IOS-STOPPED", isRunning: false },
    ]);

    const error = await tool("getApple")({ udid: "IOS-STOPPED" }).catch(
      (caught: unknown) => caught,
    );

    expect((error as DeviceAssignedToManagedSlotError).code).toBe(
      DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE,
    );
    expect(manager.wasMethodCalled("startDevice")).toBe(false);
    expect(sessionManager.getSessionForDevice("IOS-STOPPED")).toBeNull();
  });

  test("input frames to an idle slot device are refused except from the slot's execution", async () => {
    const send = (requesterSessionUuid: string | undefined) =>
      assertInputNotOnForeignManagedSlotDevice({
        action: "input/tap",
        deviceId: slotDevice.deviceId,
        platform: "ios",
        requesterSessionUuid,
        sessionManager,
        gate: DaemonState.getInstance().getDevicePool(),
      });

    for (const requester of [undefined, "other-session"]) {
      const error = await send(requester).catch((caught: unknown) => caught);
      expect((error as DeviceAssignedToManagedSlotError).code).toBe(
        DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE,
      );
    }
    await send(exec);
    await assertInputNotOnForeignManagedSlotDevice({
      action: "input/tap",
      deviceId: freeDevice.deviceId,
      platform: "ios",
      requesterSessionUuid: undefined,
      sessionManager,
      gate: DaemonState.getInstance().getDevicePool(),
    });
  });
});
