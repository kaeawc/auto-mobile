import { DaemonState } from "./daemonState";

/**
 * FUNNEL 2, as the narrowest contract a socket server can hold: refuse a serial
 * whose pooled identity is QUARANTINED.
 *
 * The device pool implements it (`DevicePool.assertDeviceActionable`), which
 * carries the rules and the reasoning. Servers that already hold a
 * `DeviceSessionResolver` reach the same gate through it; the capture and
 * recording servers hold no pool reference at all, so they take this instead of
 * growing a dependency on the whole pool
 * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
 */
export interface DeviceAdmissionGate {
  /**
   * Throws when `deviceId` names a pooled entry whose identity is unresolved.
   * `purpose` completes the refusal ("Refusing `<purpose>` on device '<serial>'").
   */
  assertDeviceActionable(deviceId: string, purpose: string): void;
}

/**
 * Admits everything. The stand-in for direct mode and for unit tests that do not
 * exercise the quarantine: with no daemon there is no pool, so nothing holds the
 * cross-call identity state a quarantine is a statement about.
 */
export const permissiveDeviceAdmissionGate: DeviceAdmissionGate = {
  assertDeviceActionable: () => {},
};

/**
 * The real gate: the device pool of the running daemon, resolved per call so a
 * server constructed before the daemon initializes still reaches it. A no-op
 * until the daemon state is initialized, for the reason on
 * {@link permissiveDeviceAdmissionGate}.
 */
export const daemonDeviceAdmissionGate: DeviceAdmissionGate = {
  assertDeviceActionable(deviceId: string, purpose: string): void {
    const daemonState = DaemonState.getInstance();
    if (!daemonState.isInitialized()) {
      return;
    }
    daemonState.getDevicePool().assertDeviceActionable(deviceId, purpose);
  },
};
