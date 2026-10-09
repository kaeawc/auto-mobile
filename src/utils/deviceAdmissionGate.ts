import type { BootedDevice } from "../models";
import type { AndroidTransportRouting } from "./androidSerial";

/** Narrow admission contract shared by device clients and daemon adapters. */
export interface DeviceAdmissionGate {
  assertDeviceActionable(deviceId: string, purpose: string): void;
  /** Optional explicit pool-owned transport resolver; direct mode has no pool. */
  getAndroidTransportRouting?(): AndroidTransportRouting;
  /**
   * Fold raw Android readiness rows onto pooled canonical ids and re-route a
   * group whose canonical transport is gone (e.g. USB unplugged, Wi-Fi alive).
   */
  mapAndroidReadinessDiscovery?(devices: readonly BootedDevice[]): BootedDevice[];
}

/** Direct mode has no pooled identity quarantine. */
export const permissiveDeviceAdmissionGate: DeviceAdmissionGate = {
  assertDeviceActionable: () => {},
};

let admissionGate: DeviceAdmissionGate | undefined;

/** The daemon publishes its pool at initialization and clears it at reset. */
export function setDeviceAdmissionGate(gate: DeviceAdmissionGate | undefined): void {
  admissionGate = gate;
}

/** Resolve the current pool per call, including for clients created before initialization. */
export const daemonDeviceAdmissionGate: DeviceAdmissionGate = {
  assertDeviceActionable(deviceId, purpose): void {
    admissionGate?.assertDeviceActionable(deviceId, purpose);
  },
  getAndroidTransportRouting(): AndroidTransportRouting {
    // Resolve the currently published pool on dispatch, including after reset.
    return {
      resolveTransport: (deviceId) =>
        admissionGate?.getAndroidTransportRouting?.().resolveTransport(deviceId) ?? deviceId,
    };
  },
  mapAndroidReadinessDiscovery(devices): BootedDevice[] {
    return admissionGate?.mapAndroidReadinessDiscovery?.(devices) ?? [...devices];
  },
};
