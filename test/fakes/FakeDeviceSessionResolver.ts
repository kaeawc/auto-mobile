import type { DeviceSessionResolver } from "../../src/daemon/deviceSessionResolver";

/**
 * In-memory {@link DeviceSessionResolver} for unit tests. Seed live serial↔uuid
 * pairs with {@link bind}; {@link retire} drops a pair so both directions miss
 * (mirroring a disconnected epoch). Unknown ids resolve to `null`.
 */
export class FakeDeviceSessionResolver implements DeviceSessionResolver {
  private readonly deviceIdToUuid = new Map<string, string>();
  private readonly uuidToDeviceId = new Map<string, string>();

  bind(deviceId: string, deviceSessionUuid: string): this {
    this.deviceIdToUuid.set(deviceId, deviceSessionUuid);
    this.uuidToDeviceId.set(deviceSessionUuid, deviceId);
    return this;
  }

  retire(deviceId: string): this {
    const uuid = this.deviceIdToUuid.get(deviceId);
    if (uuid !== undefined) {
      this.uuidToDeviceId.delete(uuid);
    }
    this.deviceIdToUuid.delete(deviceId);
    return this;
  }

  resolveUuid(deviceId: string): string | null {
    return this.deviceIdToUuid.get(deviceId) ?? null;
  }

  resolveDeviceId(deviceSessionUuid: string): string | null {
    return this.uuidToDeviceId.get(deviceSessionUuid) ?? null;
  }
}
