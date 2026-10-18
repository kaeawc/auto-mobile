import type { AndroidRecoveryRecordLedger } from "../../src/daemon/androidRecoveryRecordLedger";
import type { DevicePool } from "../../src/daemon/devicePool";
import type { DeviceRecoveryCoordinator } from "../../src/daemon/deviceRecoveryCoordinator";
import type { EmulatorLossIncidentLedger } from "../../src/daemon/emulatorLossIncidentLedger";

/**
 * Typed read access to the recovery state a DevicePool keeps in its collaborators, for suites
 * that assert on or seed it. The state lives on the recovery coordinator and the two ledgers,
 * not on the pool, so this reaches those through the pool's typed `testHooks` (#11804).
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
  const { recoveryCoordinator, androidRecoveryRecordLedger, emulatorLossLedger } = pool.testHooks;
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
