import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Mutex } from "async-mutex";
import type {
  AndroidRecoveryRecord,
  AndroidRecoveryRecordLedger,
  AndroidRecoveryReservationKind,
} from "../../src/daemon/androidRecoveryRecordLedger";
import type {
  AdbServerResetRecoveryReservation,
  DevicePool,
  PooledDevice,
  SessionPreservingRecoveryResult,
} from "../../src/daemon/devicePool";
import type {
  DeviceRecoveryCoordinator,
  SessionPreservingRecovery,
} from "../../src/daemon/deviceRecoveryCoordinator";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import type { EmulatorLossIncidentLedger } from "../../src/daemon/emulatorLossIncidentLedger";

/**
 * Typed read access to the recovery state a DevicePool keeps in its private collaborators, for
 * suites that assert on or seed it. The state lives on the recovery coordinator and the two
 * ledgers, not on the pool, so this reaches those directly instead of through pool-level
 * pass-through getters (#11804). `Reflect.get` returns `any`, so no type assertion is needed.
 */
export interface DevicePoolRecoveryInternals {
  readonly recoveryCoordinator: DeviceRecoveryCoordinator;
  readonly androidRecoveryRecordLedger: AndroidRecoveryRecordLedger;
  readonly emulatorLossLedger: EmulatorLossIncidentLedger;
  readonly recoveringAndroidImages: DeviceRecoveryCoordinator["recoveringAndroidImages"];
  readonly recoveringAndroidDeviceIds: DeviceRecoveryCoordinator["recoveringAndroidDeviceIds"];
  readonly androidRecoveryHandoffOwners: DeviceRecoveryCoordinator["androidRecoveryHandoffOwners"];
  readonly sessionPreservingRecoveries: DeviceRecoveryCoordinator["sessionPreservingRecoveries"];
  readonly recoveringSessionLosses: AndroidRecoveryRecordLedger["recoveringSessionLosses"];
  readonly failedTerminalRecoveryReleases: AndroidRecoveryRecordLedger["failedTerminalRecoveryReleases"];
  readonly emulatorLossIncidentStore: EmulatorLossIncidentLedger["emulatorLossIncidentStore"];
  readonly emulatorLossRecoverySettlements: EmulatorLossIncidentLedger["emulatorLossRecoverySettlements"];
  readonly emulatorLossRecoveryResolvers: EmulatorLossIncidentLedger["emulatorLossRecoveryResolvers"];
}

export function recoveryInternals(pool: DevicePool): DevicePoolRecoveryInternals {
  const recoveryCoordinator: DeviceRecoveryCoordinator = Reflect.get(pool, "recoveryCoordinator");
  const androidRecoveryRecordLedger: AndroidRecoveryRecordLedger = Reflect.get(
    pool,
    "androidRecoveryRecordLedger",
  );
  const emulatorLossLedger: EmulatorLossIncidentLedger = Reflect.get(pool, "emulatorLossLedger");
  return {
    recoveryCoordinator,
    androidRecoveryRecordLedger,
    emulatorLossLedger,
    recoveringAndroidImages: recoveryCoordinator.recoveringAndroidImages,
    recoveringAndroidDeviceIds: recoveryCoordinator.recoveringAndroidDeviceIds,
    androidRecoveryHandoffOwners: recoveryCoordinator.androidRecoveryHandoffOwners,
    sessionPreservingRecoveries: recoveryCoordinator.sessionPreservingRecoveries,
    recoveringSessionLosses: androidRecoveryRecordLedger.recoveringSessionLosses,
    failedTerminalRecoveryReleases: androidRecoveryRecordLedger.failedTerminalRecoveryReleases,
    emulatorLossIncidentStore: emulatorLossLedger.emulatorLossIncidentStore,
    emulatorLossRecoverySettlements: emulatorLossLedger.emulatorLossRecoverySettlements,
    emulatorLossRecoveryResolvers: emulatorLossLedger.emulatorLossRecoveryResolvers,
  };
}

/**
 * Private DevicePool members suites reach into. `poolInternals` returns the pool itself, so the
 * members are real: `spyOn` intercepts them and assigning one replaces it. The view comes from
 * `Reflect.get` (which returns `any`), so no type assertion is needed or counted.
 */
export interface DevicePoolInternals {
  startedDeviceProcesses: Map<string, ChildProcess>;
  startedDeviceProcessOutput: Map<string, unknown>;
  releasedDeviceCaptures: Map<string, { deviceId: string }>;
  trackStartedDeviceProcess(
    device: BootedDevice,
    child: ChildProcess | EventEmitter | null | undefined,
  ): Promise<void>;
  evictMissingPooledDevice(
    device: PooledDevice,
    reason: string,
    options?: { attemptDeviceLossRecovery?: boolean; incidentId?: string },
  ): Promise<void>;
  assignmentMutex: Pick<Mutex, "runExclusive">;
  adbServerResetQuarantinedSessions: Set<string>;
  adbServerResetRecoveryReservations: Map<string, AdbServerResetRecoveryReservation>;
  recoveryCoordinator: DeviceRecoveryCoordinator;
  afterAndroidStartupRecoverySnapshot?: () => void;
  startAndroidRecoveryRecord(
    sessionId: string,
    details: Omit<
      Partial<AndroidRecoveryRecord>,
      "sessionId" | "generation" | "state" | "reservations"
    >,
    reservations: readonly AndroidRecoveryReservationKind[],
    replace?: boolean,
  ): AndroidRecoveryRecord;
  completeEmulatorLossRecovery(
    incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
    releasedSessionState?: "awaiting-device",
  ): Promise<void>;
  joinSessionPreservingRecovery(
    recovery: SessionPreservingRecovery,
    incidentId: string | undefined,
  ): Promise<SessionPreservingRecoveryResult>;
  captureReleasedDevice(sessionId: string, deviceId: string): void;
  runCoordinatedDeviceStart(device: DeviceInfo, deadlineMs: number, op: "start"): Promise<unknown>;
}

export function poolInternals(pool: DevicePool): DevicePoolInternals {
  return Reflect.get({ pool }, "pool");
}
