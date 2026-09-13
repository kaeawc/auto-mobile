import type { DeviceSessionResolver } from "../../src/daemon/deviceSessionResolver";

/**
 * In-memory {@link DeviceSessionResolver} for unit tests. Seed live serial↔uuid
 * pairs with {@link bind}; {@link retire} drops a pair so both directions miss
 * (mirroring a disconnected epoch). Unknown ids resolve to `null`.
 *
 * {@link quarantine} models the pool's `identityUnresolved` state: the pair is
 * KEPT (so {@link resolveIdentity} resumes the same epoch) but withheld from both
 * directions, and routing for that serial reports as suspended.
 */
export class FakeDeviceSessionResolver implements DeviceSessionResolver {
  private readonly deviceIdToUuid = new Map<string, string>();
  private readonly uuidToDeviceId = new Map<string, string>();
  private readonly quarantined = new Set<string>();

  bind(deviceId: string, deviceSessionUuid: string): this {
    const previousUuid = this.deviceIdToUuid.get(deviceId);
    if (previousUuid !== undefined && previousUuid !== deviceSessionUuid) {
      this.uuidToDeviceId.delete(previousUuid);
    }
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

  /** Withhold this serial's routing identity, as the pool's quarantine does. */
  quarantine(deviceId: string): this {
    this.quarantined.add(deviceId);
    return this;
  }

  /** Lift {@link quarantine}, restoring the epoch that was preserved underneath it. */
  resolveIdentity(deviceId: string): this {
    this.quarantined.delete(deviceId);
    return this;
  }

  resolveUuid(deviceId: string): string | null {
    if (this.quarantined.has(deviceId)) {
      return null;
    }
    return this.deviceIdToUuid.get(deviceId) ?? null;
  }

  resolveDeviceId(deviceSessionUuid: string): string | null {
    const deviceId = this.uuidToDeviceId.get(deviceSessionUuid);
    if (deviceId === undefined || this.quarantined.has(deviceId)) {
      return null;
    }
    return deviceId;
  }

  isRoutingSuspended(deviceId: string): boolean {
    return this.quarantined.has(deviceId);
  }
}
