import { DaemonState } from "./daemonState";
import type { DiscoveryReconcileOptions } from "./devicePool";
import type { BootedDevice } from "../models";

/**
 * FUNNEL 1, for callers outside {@link DevicePool}.
 *
 * Every code path that discovers Android devices and then CONSULTS pooled
 * identity — publishing an epoch or an AVD label, routing a serial, admitting
 * device-addressed work, confirming a destructive action — must fold its
 * observation in here BEFORE it reads pool state. `DevicePool.reconcileDiscoveryObservation`
 * carries the rules and the reasoning; this wrapper only resolves the pool.
 *
 * Without the funnel each site decided for itself what to do with an
 * `Unknown (<serial>)` placeholder, so the first read to see one merely withheld
 * its OWN output while the pool — and therefore every other consumer, including
 * the admission gate — carried on trusting the stale label
 * ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
 *
 * A no-op in direct mode, where there is no daemon and therefore no pool: nothing
 * holds cross-call identity state, so there is nothing to reconcile.
 *
 * Enforced by `test/lint/deviceDiscoveryReconcileFunnel.test.ts`, which fails on a
 * new direct discovery call site that is not in its allowlist.
 */
export async function reconcileDiscoveryObservation(
  devices: readonly BootedDevice[],
  source: string,
  options: DiscoveryReconcileOptions = {},
): Promise<void> {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return;
  }
  await daemonState.getDevicePool().reconcileDiscoveryObservation(devices, source, options);
}
