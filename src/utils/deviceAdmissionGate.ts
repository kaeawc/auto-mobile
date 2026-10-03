/** Narrow admission contract shared by device clients and daemon adapters. */
export interface DeviceAdmissionGate {
  assertDeviceActionable(deviceId: string, purpose: string): void;
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
};
