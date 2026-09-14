import { DevicePool } from "../../src/daemon/devicePool";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

export const QUARANTINE_POOL_SERIAL = "emulator-5554";
export const QUARANTINE_POOL_AVD = "Pixel_8_API_35";

export interface IdentityQuarantinePool {
  readonly pool: DevicePool;
  readonly timer: FakeTimer;
  readonly pooled: BootedDevice;
  /** A discovery observation naming a DIFFERENT AVD on the pooled serial. */
  readonly disagreeing: BootedDevice;
}

/**
 * A live daemon pool (installed into {@link DaemonState}) holding ONE labelled
 * Android emulator that is bound to a session, so a disagreeing discovery
 * observation folded through `reconcileDiscoveryObservation` enters the identity
 * quarantine and awaits the injected execution canceller
 * (`DevicePool.enterPooledIdentityQuarantine`).
 *
 * `onCancelExecutions` is that seam: a test that must act WHILE reconciliation
 * is awaiting the quarantine (aborting the caller, say) runs there. Callers
 * reset `DaemonState` themselves in `afterEach`.
 */
export async function createIdentityQuarantinePool(
  onCancelExecutions: () => void = () => {},
): Promise<IdentityQuarantinePool> {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const utils = new FakeDeviceUtils();
  const pooled: BootedDevice = {
    deviceId: QUARANTINE_POOL_SERIAL,
    name: QUARANTINE_POOL_AVD,
    platform: "android",
  };
  utils.setBootedDevices("android", [pooled]);
  const pool = new DevicePool(
    manager,
    "daemon-test",
    timer,
    new FakeInstalledAppsRepository(),
    utils,
    new DefaultRetryExecutor(timer),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      onCancelExecutions();
      return 0;
    },
  );
  DaemonState.getInstance().initialize(manager, pool);
  await pool.initializeWithDevices([pooled]);
  await pool.bindOrReuseDeviceSession("owning-session", pooled.deviceId, "android");
  return {
    pool,
    timer,
    pooled,
    disagreeing: { deviceId: QUARANTINE_POOL_SERIAL, name: "Pixel_7_API_34", platform: "android" },
  };
}
