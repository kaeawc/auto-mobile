import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { makePool } from "../helpers/makePool";
import { ToolRegistry, type ToolRegistryCollaborators } from "../../src/server/toolRegistry";
import type { DeviceAwareToolOptions } from "../../src/server/toolRegistry";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager, TerminalSessionError } from "../../src/daemon/sessionManager";
import type { DevicePool } from "../../src/daemon/devicePool";
import type { DeviceSession } from "../../src/db/types";
import { deviceRestartReleaseReason } from "../../src/db/deviceSessionRepository";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
import { SessionRecoveryAssignmentError } from "../../src/models/SessionRecoveryAssignmentError";
import { stubCtrlProxySetup, type CtrlProxySetupStub } from "../helpers/stubCtrlProxySetup";

/**
 * #19191: a read-only call (observe, wearSurface watchFace/listTileProviders, storeKitTest list)
 * naming a session whose emulator was lost fails with the session's typed recovery error, exactly
 * like a control call, and never falls back to sessionless selection of another device.
 */
describe("read naming a lost session (#19191)", () => {
  const sessionDevice: BootedDevice = {
    name: "Pixel A",
    deviceId: "emulator-5554",
    platform: "android",
  };
  const otherDevice: BootedDevice = {
    name: "Other client",
    deviceId: "emulator-5556",
    platform: "android",
  };
  const sessionUuid = "lost-emulator-session";

  /** Released by the emulator crash, with its restart recovery window still open. */
  const lostRow: DeviceSession = {
    session_uuid: sessionUuid,
    device_id: sessionDevice.deviceId,
    stable_device_id: sessionDevice.name,
    platform: "android",
    status: "released",
    source: null,
    autolock_enabled: 0,
    mcp_session_id: null,
    daemon_session_id: "new-daemon",
    created_at_ms: 1,
    last_used_at_ms: 0,
    expires_at_ms: 600_000,
    released_at_ms: 0,
    release_reason: deviceRestartReleaseReason(sessionDevice.name),
    session_timeout_ms: 600_000,
    heartbeat_timeout_ms: 60_000,
    has_received_heartbeat: 1,
    activity_seq: 0,
    stable_identity_generation: 0,
    heartbeat_timeout_source: null,
    liveness_contract_generation: 0,
    liveness_owner_token: null,
    liveness_policy: null,
    pre_cli_heartbeat_timeout_ms: null,
    pre_cli_heartbeat_timeout_source: null,
    pre_cli_session_timeout_ms: null,
    created_at: "2026-11-24T00:00:00.000Z",
    updated_at: "2026-11-24T00:00:00.000Z",
  };

  const readShapes: Array<[string, Pick<DeviceAwareToolOptions, "deviceReadOnly">]> = [
    ["a wholly read-only tool (observe)", { deviceReadOnly: true }],
    [
      "a per-call read (wearSurface watchFace, storeKitTest list)",
      { deviceReadOnly: (args: { action?: string }) => args.action === "list" },
    ],
  ];

  let readiness: FakeDeviceReadiness;
  let originalCollaborators: ToolRegistryCollaborators;
  let restoreInventory: () => void;
  let ctrlProxyStub: CtrlProxySetupStub;
  let sessions: SessionManager;
  let timer: FakeTimer;
  let pool: DevicePool;
  let manager: FakeDeviceManager;
  let ranOn: BootedDevice[];

  async function loseEmulator(): Promise<void> {
    timer = new FakeTimer();
    const persistence = new FakeDeviceSessionPersistence();
    persistence.seed({ ...lostRow });
    sessions = new SessionManager(timer, persistence);
    sessions.stopCleanupTimer();
    const incidents = new InMemoryEmulatorLossIncidentStore(timer);
    manager = new FakeDeviceManager();
    pool = makePool(sessions, "new-daemon", {
      timer,
      deviceManager: manager,
      emulatorLossIncidentStore: incidents,
    });
    DaemonState.getInstance().initialize(sessions, pool);
    const incident = await incidents.open({
      deviceId: sessionDevice.deviceId,
      avdName: sessionDevice.name,
      detectionPath: "watched-process-exit",
      processExit: { code: null, signal: "SIGSEGV" },
      recoveryPolicy: { onLoss: false, maxAttempts: 1 },
      session: {
        sessionUuid,
        state: "recovering",
        lastHeartbeatMs: 0,
        hasReceivedHeartbeat: true,
        heartbeatTimeoutMs: 60_000,
      },
    });
    await incidents.completeRecovery(incident.id, "not-attempted");
    // Another client's emulator is the only device a sessionless read could select.
    readiness.setConnectedDevices([otherDevice]);
  }

  function register(options: Pick<DeviceAwareToolOptions, "deviceReadOnly">): void {
    ToolRegistry.registerDeviceAware(
      "lostSessionRead",
      "Lost session read probe",
      z.object({ sessionUuid: z.string().optional(), action: z.string().optional() }),
      {
        handler: async (device: BootedDevice) => {
          ranOn.push(device);
          return { success: true };
        },
        deviceReadiness: "booted",
        ...options,
      },
    );
  }

  const read = (deadlineMs: number) =>
    runWithToolSelectionContext({ requestDeadline: { deadlineMs } }, () =>
      ToolRegistry.getTool("lostSessionRead")!.handler({
        sessionUuid,
        platform: "android",
        action: "list",
      }),
    ).catch((error: unknown) => error);

  beforeEach(() => {
    ranOn = [];
    ToolRegistry.clearTools();
    restoreInventory = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    readiness = new FakeDeviceReadiness();
    originalCollaborators = ToolRegistry.getCollaboratorsForTesting();
    ToolRegistry.setCollaboratorsForTesting({
      deviceReadiness: readiness,
      toolCallRepository: { async recordToolCall(): Promise<void> {} },
    });
    ctrlProxyStub = stubCtrlProxySetup();
  });

  afterEach(() => {
    restoreInventory();
    ToolRegistry.setCollaboratorsForTesting(originalCollaborators);
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessions?.stopCleanupTimer();
    ctrlProxyStub.restore();
  });

  test.each(readShapes)(
    "%s inside the recovery window gets the typed recovery error",
    async (_shape, options) => {
      await loseEmulator();
      register(options);
      timer.advanceTime(60_001);
      const error = await read(120_000);
      expect(error).toBeInstanceOf(SessionRecoveryAssignmentError);
      expect(error).toMatchObject({
        details: {
          code: "session_recovery_pending",
          sessionUuid,
          deviceId: sessionDevice.deviceId,
          processExit: { code: null, signal: "SIGSEGV" },
        },
      });
      expect(ranOn).toEqual([]);
    },
  );

  test.each(readShapes)(
    "%s after the recovery window gets the terminal session error",
    async (_shape, options) => {
      await loseEmulator();
      register(options);
      timer.advanceTime(300_001);
      const error = await read(400_000);
      expect(error).toBeInstanceOf(TerminalSessionError);
      expect(error).toMatchObject({
        release: { releaseReason: "restart-recovery-timeout", terminal: true },
      });
      expect(ranOn).toEqual([]);
    },
  );

  test.each(readShapes)(
    "%s runs on the session's own device once it returns, then under the live session",
    async (_shape, options) => {
      await loseEmulator();
      register(options);
      manager.bootedDevices = [sessionDevice];
      await pool.addDevice(sessionDevice);
      readiness.setConnectedDevices([sessionDevice, otherDevice]);
      expect(await read(120_000)).toMatchObject({ success: true });
      expect(sessions.getSession(sessionUuid)?.assignedDevice).toBe(sessionDevice.deviceId);
      // The healthy-session path: a read under the live session reads its device.
      expect(await read(120_000)).toMatchObject({ success: true });
      expect(ranOn.map((device) => device.deviceId)).toEqual([
        sessionDevice.deviceId,
        sessionDevice.deviceId,
      ]);
    },
  );
});
