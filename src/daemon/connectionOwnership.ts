import { holderOf } from "./deviceBinding";
import type { Platform } from "../models";
import type { PooledDevice } from "./devicePool";
import type { ForeignDeviceOwnership } from "./foreignDeviceOwnership";

export interface ConnectionOwnershipPort {
  foreignOwnershipFor(platform: Platform | undefined): ForeignDeviceOwnership | undefined;
  getDevice(deviceId: string): Pick<PooledDevice, "platform" | "sessionId"> | undefined;
}

export class ConnectionOwnership {
  /** Devices whose allocation claim this daemon published and has not withdrawn, by claim store. */
  private readonly claimedDeviceIds = new Map<string, ForeignDeviceOwnership>();

  constructor(private readonly port: ConnectionOwnershipPort) {}

  /**
   * Publish this daemon's claim on an Android device a session holds. False only when another
   * live daemon's claim on it is still in use. A claim that lands after the session already let
   * the device go, with no other session holding it, is withdrawn again, so it never outlives the
   * assignment.
   */
  async publishDeviceClaim(deviceId: string): Promise<boolean> {
    const ownership = this.port.foreignOwnershipFor(this.port.getDevice(deviceId)?.platform);
    if (!ownership) {
      return true;
    }
    if (!(await ownership.claim(deviceId))) {
      return false;
    }
    this.claimedDeviceIds.set(deviceId, ownership);
    // The claim is this daemon's, not one session's: a session that took the device since
    // depends on it, so it is only withdrawn when nothing here holds the device (#11565).
    if (!holderOf(this.port.getDevice(deviceId))) {
      this.releaseDeviceClaim(deviceId);
    }
    return true;
  }

  /** Withdraw this daemon's claim once no session of this daemon holds the device. */
  releaseDeviceClaim(deviceId: string): void {
    const ownership = this.claimedDeviceIds.get(deviceId);
    if (ownership) {
      this.claimedDeviceIds.delete(deviceId);
      ownership.release(deviceId);
    }
  }

  releaseAll(): void {
    for (const deviceId of [...this.claimedDeviceIds.keys()]) {
      this.releaseDeviceClaim(deviceId);
    }
  }

  recordClaim(deviceId: string, ownership: ForeignDeviceOwnership): void {
    this.claimedDeviceIds.set(deviceId, ownership);
  }

  hasClaim(deviceId: string): boolean {
    return this.claimedDeviceIds.has(deviceId);
  }
}
