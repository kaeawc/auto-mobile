import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { ForeignDeviceOwnership } from "../../../src/daemon/foreignDeviceOwnership";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../../src/devices/virtualDeviceLifecycleCoordinator";
import { RegistryManagedSlotExclusion } from "../../../src/daemon/managedSlots/managedSlotExclusion";
import { MANAGED_SLOT_DISCOVERY_INCOMPLETE_CODE } from "../../../src/daemon/managedSlots/managedSlotRefusal";
import type { BootedDevice } from "../../../src/models";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import { shapeToolCallError } from "../../../src/server/shapeToolCallError";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../../src/server/videoRecordingManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = { name: "iPhone Peer", deviceId: "IOS-PEER", platform: "ios" };

const deleteArgs = () => ({
  target: { platform: "ios", isVirtual: true, stableId: device.deviceId },
  mode: "destroy",
  verifyAbsence: true,
  timeoutMs: 60_000,
});

type Body = { failure?: Record<string, unknown> } & Record<string, unknown>;

/**
 * killDevice throws typed refusals that the MCP boundary shapes with `code`, `retryable` and
 * `retryAfterMs`. deleteDevice returns the same refusals as a precondition failure result; the
 * typed fields must survive that path too, or a client cannot tell a retryable refusal from a
 * permanent one.
 */
describe("lifecycle: deleteDevice typed refusals match killDevice's", () => {
  let manager: FakeDeviceUtils;
  let sessionManager: SessionManager;
  let foreignPid: number | undefined;
  let registryReadable: boolean;

  const peerOwnership: ForeignDeviceOwnership = {
    refresh: async () => {},
    foreignOwnerPid: () => foreignPid,
    claim: async () => foreignPid === undefined,
    release: () => {},
  };

  const tool = (name: string) => ToolRegistry.getTool(name)!.handler;

  beforeEach(async () => {
    ToolRegistry.clearTools();
    foreignPid = undefined;
    registryReadable = true;
    const timer = new FakeTimer();
    manager = new FakeDeviceUtils();
    await setVideoRecordingManagerDependencies({
      videoRecorderService: {} as never,
      recordingRepository: { listRecordings: async () => [] } as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer,
      now: () => new Date(0),
    });
    manager.setBootedDevices("ios", [device]);
    manager.setDeviceImages("ios", [{ ...device, isRunning: true }]);
    setDeviceToolsDependencies({
      lifecycleCoordinator: new InMemoryVirtualDeviceLifecycleCoordinator(timer),
      deviceManagerFactory: () => manager,
      notifyResourcesChanged: async () => {},
      ensureCtrlProxyReady: async () => {},
      clearInstalledAppsForDevice: async () => {},
      timer,
    });
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "lifecycle-hunt", {
        timer,
        deviceManager: manager,
        iosForeignDeviceOwnership: peerOwnership,
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => {
          if (!registryReadable) {
            throw new Error("slot registry locked");
          }
          return { snapshotManagedDevices: async () => [] } as never;
        }, timer),
      }),
    );
    await pool.initializeWithDevices([device]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    registerDeviceTools();
  });

  afterEach(() => {
    ToolRegistry.clearTools();
    resetDeviceToolsDependencies();
    resetVideoRecordingManagerDependencies();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  async function killWire(): Promise<Record<string, unknown>> {
    const error = await tool("killDevice")({ device }).catch((caught: unknown) => caught);
    return JSON.parse(
      shapeToolCallError(error, { toolName: "killDevice", source: "MCP" }).content[0].text,
    ) as Record<string, unknown>;
  }

  async function deleteBody(): Promise<Body> {
    const response = (await tool("deleteDevice")(deleteArgs())) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(response.content[0].text) as Body;
  }

  test("a device another daemon holds is refused as retryable with retryAfterMs by both tools", async () => {
    foreignPid = 4242;
    const killed = await killWire();
    expect(killed).toMatchObject({
      code: "device_owned_by_other_daemon",
      retryable: true,
      retryAfterMs: expect.any(Number),
    });

    const deleted = await deleteBody();
    expect(deleted.failure).toMatchObject({
      code: "device_owned_by_other_daemon",
      phase: "precondition",
    });
    // killDevice reports retryable: true; deleteDevice drops the field entirely.
    expect(deleted.failure).toMatchObject({ retryable: true, retryAfterMs: killed.retryAfterMs });
    expect(manager.wasMethodCalled("destroyDevice")).toBe(false);
  });

  test("an unreadable managed-slot registry is a typed retryable refusal, not operation_failed", async () => {
    registryReadable = false;
    const killed = await killWire();
    expect(killed).toMatchObject({
      code: MANAGED_SLOT_DISCOVERY_INCOMPLETE_CODE,
      retryable: true,
    });

    const deleted = await deleteBody();
    // Fails closed (nothing is destroyed) but loses its type: code is "operation_failed".
    expect(deleted.failure).toMatchObject({
      code: MANAGED_SLOT_DISCOVERY_INCOMPLETE_CODE,
      retryable: true,
    });
    expect(manager.wasMethodCalled("destroyDevice")).toBe(false);
  });
});
