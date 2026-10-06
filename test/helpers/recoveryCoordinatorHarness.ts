import {
  DeviceRecoveryCoordinator,
  type DeviceRecoveryPoolPort,
} from "../../src/daemon/deviceRecoveryCoordinator";
import { AndroidRecoveryRecordLedger } from "../../src/daemon/androidRecoveryRecordLedger";
import { FakeTimer } from "../fakes/FakeTimer";
import type { PooledDevice } from "../../src/daemon/devicePool";

/** A real DeviceRecoveryCoordinator over an inert pool port, for coordinator-level tests. */
export function recoveryCoordinatorHarness() {
  const timer = new FakeTimer();
  const ledger = new AndroidRecoveryRecordLedger(
    { getDevice: () => null, getSession: () => null, clearAdbResetReservation: () => {} },
    timer,
  );
  const records = ledger.recoveringSessionLosses;
  const quarantined = new Set<string>();
  const settlements = new Map<string, Promise<void>>();
  let refreshGeneration = 0;
  const port: DeviceRecoveryPoolPort = {
    getRefreshGeneration: () => refreshGeneration,
    getPooledDevice: () => undefined,
    getSessionForDevice: () => undefined,
    waitForReleasingSession: () => undefined,
    getAndroidSessionPreservingRecoveryTarget: () => undefined,
    getSessionPreservingRecoveryTarget: () => undefined,
    isIOSSimulatorContinuityDevice: (device): device is PooledDevice & { platform: "ios" } =>
      device.platform === "ios",
    performSessionPreservingRecovery: async () => "not-attempted",
    finishEmulatorLossIncident: async () => {},
    recoverSessionBoundAndroidDeviceAfterAdbServerReset: async () => false,
    releaseAdbServerResetCohortReservations: async () => {},
    getEmulatorLossIncident: async () => undefined,
    completeJoinedEmulatorLossRecovery: async () => {},
    getRecoveringSessionLosses: () => records,
    getTimer: () => timer,
    getAndroidRecoveryRecordLedger: () => ledger,
    getAdbServerResetQuarantinedSessions: () => quarantined,
    getEmulatorLossRecoverySettlements: () => settlements,
    hasReleasedDeviceCapture: () => false,
    refreshEmulatorLossRecoverySettlement: async () => {},
    settleEmulatorLossIncident: () => {},
    completeEmulatorLossRecovery: async () => {},
    releaseDisconnectedRecoverySessionWithRetry: async (_sessionId, _deviceId, _reason, attempt) =>
      attempt(),
    releaseDevice: async () => {},
  };
  return {
    coordinator: new DeviceRecoveryCoordinator(port),
    port,
    records,
    ledger,
    quarantined,
    timer,
    setRefreshGeneration: (generation: number) => {
      refreshGeneration = generation;
    },
  };
}
