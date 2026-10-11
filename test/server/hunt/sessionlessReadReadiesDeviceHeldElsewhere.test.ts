import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DeviceOwnedByOtherDaemonError } from "../../../src/daemon/deviceAcquisitionRefusals";
import { DevicePool } from "../../../src/daemon/devicePool";
import { DeviceAssignedToManagedSlotError } from "../../../src/daemon/managedSlots/managedSlotRefusal";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { DeviceSessionManager } from "../../../src/devices/DeviceSessionManager";
import type { AppearanceConfig, AppearanceMode, BootedDevice } from "../../../src/models";
import type { DeviceObservationAccess } from "../../../src/server/deviceObservationAccess";
import { ToolRegistry, type AuditRunnerInput } from "../../../src/server/toolRegistry";
import { isSessionlessDeviceRead } from "../../../src/features/toolSelection/toolSelectionContext";
import type { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../../fakes/FakeDeviceClientProvider";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../../fakes/FakeDisplayInventoryProvider";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeVirtualDeviceLifecycleCoordinator } from "../../fakes/FakeVirtualDeviceLifecycleCoordinator";
import { FakeWindow } from "../../fakes/FakeWindow";

/**
 * HUNT: a sessionless READ through the tool pipeline runs full device readiness on a device that
 * someone else holds without a local session: an idle managed slot's device, or a device another
 * daemon claims. Readiness is not a read: `DeviceSessionManager.finishReadinessSelection` pins the
 * current device, applies the host appearance (`cmd uimode night …`, appearance-on-connect) and
 * writes `settings put secure stylus_handwriting_enabled 0`.
 *
 * `ToolRegistry` only diverts a sessionless read to the read-only device path when a session of
 * THIS daemon holds the target (`isDeviceHeldInDaemon`). The managed-slot and foreign-daemon gates
 * (`assertManagedSlotControlAccess`) return early for reads, which is right for admission ("reads
 * are open everywhere") but leaves the read on the readiness path. `request_observation` already
 * takes the connect-only read for all three holders (test/daemon/observationRequestHeldElsewhere).
 *
 * The control probe in each test shows the device really is held elsewhere as far as the pipeline
 * is concerned: the same call as a control tool gets the typed refusal.
 */
describe("HUNT: a sessionless read readies (and re-themes) a device held outside this daemon's sessions", () => {
  const mine: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const theirs: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };

  let reads: Array<{ deviceId: string; readPath: boolean }>;
  let adb: FakeAdbExecutor;
  let appearanceApplies: Array<{ deviceId: string; mode: AppearanceMode }>;
  let pool: DevicePool;
  let sessionManager: SessionManager;
  let restorePipeline: () => void;
  let originalDeviceSessionManager: unknown;
  let originalToolCallRepository: unknown;
  let originalNavigationRecorder: unknown;

  const call = (name: string, args: Record<string, unknown>) =>
    ToolRegistry.getTool(name)!.handler(args);

  const deviceWrites = () =>
    adb
      .getExecutedCommands()
      .filter((command) => /cmd uimode night|settings put|settings delete/.test(command));

  beforeEach(async () => {
    reads = [];
    appearanceApplies = [];
    ToolRegistry.clearTools();
    const deviceReadAccess: DeviceObservationAccess = {
      listBooted: async () => [mine, theirs],
      isAuthorized: () => true,
    };
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
      deviceReadAccess,
      auditRunner: {
        async run(input: AuditRunnerInput) {
          return input.handler(input.device, input.args);
        },
      },
      afterToolCall: {
        async handle(input) {
          return { durationMs: 0, finalizedResponse: input.response };
        },
      },
    });

    // The REAL DeviceSessionManager over fakes, so readiness's device writes are observable.
    adb = new FakeAdbExecutor();
    adb.setDevices([mine, theirs]);
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("android", [mine, theirs]);
    const window = new FakeWindow();
    window.configureActiveWindow({ appId: "com.example", activityName: "Main", layoutSeqSum: 0 });
    const hostFollowingConfig: AppearanceConfig = {
      syncWithHost: true,
      defaultMode: "auto",
      applyOnConnect: true,
    };
    const devices = DeviceSessionManager.createInstance(
      new FakeDeviceClientProvider(adb, deviceUtils, new FakeSimctl() as unknown as SimCtlClient, {
        window,
      }),
      { create: () => adb },
      {
        appearanceOnConnectDependencies: {
          isSyncEnabled: () => true,
          getConfig: mock(async () => hostFollowingConfig),
          resolveMode: mock(async (): Promise<AppearanceMode> => "dark"),
          apply: mock(async (target: BootedDevice, mode: AppearanceMode) => {
            appearanceApplies.push({ deviceId: target.deviceId, mode });
            await adb.executeCommand(`shell cmd uimode night ${mode === "dark" ? "yes" : "no"}`);
          }),
        },
        runnerReadinessTimer: new FakeTimer(),
        lifecycleCoordinator: new FakeVirtualDeviceLifecycleCoordinator(),
        admissionGate: { assertDeviceActionable: () => {} },
        executionBinding: { bindDeviceExecution: () => {} },
      },
    );
    originalDeviceSessionManager = Reflect.get(ToolRegistry, "deviceSessionManager");
    Reflect.set(ToolRegistry, "deviceSessionManager", devices);
    originalToolCallRepository = Reflect.get(ToolRegistry, "toolCallRepository");
    Reflect.set(ToolRegistry, "toolCallRepository", { async recordToolCall(): Promise<void> {} });
    originalNavigationRecorder = Reflect.get(ToolRegistry, "navigationToolCallRecorder");
    Reflect.set(ToolRegistry, "navigationToolCallRecorder", { record: () => undefined });

    const timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "hunt-read-held-elsewhere", {
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices([mine, theirs]);
    DaemonState.getInstance().initialize(sessionManager, pool);

    ToolRegistry.registerDeviceAware(
      "readProbe",
      "Read-only probe",
      z.object({}).passthrough(),
      async (device: BootedDevice) => {
        reads.push({ deviceId: device.deviceId, readPath: isSessionlessDeviceRead() });
        return { success: true };
      },
      { deviceReadOnly: true, deviceReadiness: "booted" },
    );
    ToolRegistry.registerDeviceAware(
      "controlProbe",
      "Control probe",
      z.object({}).passthrough(),
      async () => ({ success: true }),
      { deviceReadiness: "booted" },
    );
  });

  afterEach(() => {
    restorePipeline();
    Reflect.set(ToolRegistry, "deviceSessionManager", originalDeviceSessionManager);
    Reflect.set(ToolRegistry, "toolCallRepository", originalToolCallRepository);
    Reflect.set(ToolRegistry, "navigationToolCallRecorder", originalNavigationRecorder);
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  test("a read on a device ANOTHER DAEMON claims writes night mode and a secure setting to it", async () => {
    // The pool's cross-daemon claim verdict for `theirs`: a live peer daemon (pid 4242) owns it.
    pool.assertNotClaimedByForeignDaemon = async (deviceId) => {
      if (deviceId === theirs.deviceId) {
        throw new DeviceOwnedByOtherDaemonError(deviceId, 4242);
      }
    };
    // Control is refused before any device work, so the device is held elsewhere for the pipeline.
    await expect(
      call("controlProbe", { platform: "android", deviceId: theirs.deviceId }),
    ).rejects.toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect(deviceWrites()).toEqual([]);

    await call("readProbe", { platform: "android", deviceId: theirs.deviceId });

    expect(reads.map((read) => read.deviceId)).toEqual([theirs.deviceId]);
    // FAILS: the read ran readiness on the peer daemon's device and wrote
    // "shell cmd uimode night yes" and "shell settings put secure stylus_handwriting_enabled 0".
    expect(appearanceApplies).toEqual([]);
    expect(deviceWrites()).toEqual([]);
  });

  test("a read on another execution's idle MANAGED SLOT device writes night mode and a secure setting to it", async () => {
    pool.assertNotAssignedToManagedSlot = async (input) => {
      if (input.deviceId === theirs.deviceId && input.requesterSessionUuid !== "slot-exec") {
        throw new DeviceAssignedToManagedSlotError(input.action, input.deviceId, {
          platform: "android",
          stableDeviceId: "Pixel_B",
          holder: "slot",
          scopeKey: "scope",
          slotIndex: 0,
          scopeState: null,
          execSessionUuid: "slot-exec",
        });
      }
    };
    await expect(
      call("controlProbe", { platform: "android", deviceId: theirs.deviceId }),
    ).rejects.toBeInstanceOf(DeviceAssignedToManagedSlotError);
    expect(deviceWrites()).toEqual([]);

    await call("readProbe", { platform: "android", deviceId: theirs.deviceId });

    expect(reads.map((read) => read.deviceId)).toEqual([theirs.deviceId]);
    // FAILS: same writes, on a device a managed slot holds for another execution.
    expect(appearanceApplies).toEqual([]);
    expect(deviceWrites()).toEqual([]);
  });
});
