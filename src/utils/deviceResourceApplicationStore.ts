import type {
  DeviceResourceApplicationRecord,
  SimulatorResourceIdentity,
} from "../models/DeviceResourceReconciliation";
import { stableStringify } from "./stableStringify";

/** Persists only AutoMobile-applied overrides per simulator incarnation. */
export interface DeviceResourceApplicationStore {
  get(identity: SimulatorResourceIdentity): Promise<DeviceResourceApplicationRecord | null>;
  put(record: DeviceResourceApplicationRecord): Promise<void>;
  delete(identity: SimulatorResourceIdentity): Promise<void>;
}

/** Order-insensitive key over the full incarnation identity, never the UDID alone. */
export function simulatorResourceIdentityKey(identity: SimulatorResourceIdentity): string {
  return stableStringify({
    platform: identity.platform,
    udid: identity.udid,
    runtimeId: identity.runtimeId,
    deviceTypeId: identity.deviceTypeId,
  });
}
