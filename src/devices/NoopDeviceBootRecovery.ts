import { type DeviceInfo } from "../models";
import type { DeviceBootRecovery } from "./deviceBootRecovery";

/** The default product policy: surface the first boot failure unchanged. */
export class NoopDeviceBootRecovery implements DeviceBootRecovery {
  run<T>(_target: DeviceInfo, boot: () => Promise<T>, _signal?: AbortSignal): Promise<T> {
    return boot();
  }
}
