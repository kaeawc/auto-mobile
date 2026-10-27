import type { Platform } from "../../src/models";
import type { DeviceClaim, DeviceClaims } from "../../src/daemon/deviceClaims";

/** In-memory `device_claims`: one row per (platform, device), with the real release guard. */
export class FakeDeviceClaims implements DeviceClaims {
  readonly rows = new Map<string, DeviceClaim>();
  /** Writes still to fail, as a busy registry does. */
  failWrites = 0;

  private key(platform: Platform, deviceId: string): string {
    return `${platform}:${deviceId}`;
  }

  async upsert(claim: DeviceClaim): Promise<void> {
    this.failIfBusy();
    this.rows.set(this.key(claim.platform, claim.deviceId), { ...claim });
  }

  async release(
    platform: Platform,
    deviceId: string,
    owner: { pid: number; ownerToken: string },
  ): Promise<void> {
    this.failIfBusy();
    const held = this.rows.get(this.key(platform, deviceId));
    if (held?.pid === owner.pid && held.ownerToken === owner.ownerToken) {
      this.rows.delete(this.key(platform, deviceId));
    }
  }

  async get(platform: Platform, deviceId: string): Promise<DeviceClaim | undefined> {
    return this.rows.get(this.key(platform, deviceId));
  }

  async list(): Promise<DeviceClaim[]> {
    return [...this.rows.values()];
  }

  private failIfBusy(): void {
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error("SQLITE_BUSY: database is locked");
    }
  }
}
