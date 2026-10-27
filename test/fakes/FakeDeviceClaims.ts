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
    const key = this.key(claim.platform, claim.deviceId);
    const held = this.rows.get(key);
    if (held && held.updatedAtMs > claim.updatedAtMs) {
      return;
    }
    const sameOwner = held?.pid === claim.pid && held.ownerToken === claim.ownerToken;
    this.rows.set(key, { ...claim, claimedAtMs: sameOwner ? held.claimedAtMs : claim.claimedAtMs });
  }

  async releaseOwnedBy(pid: number): Promise<void> {
    this.failIfBusy();
    for (const [key, row] of this.rows) {
      if (row.pid === pid) {
        this.rows.delete(key);
      }
    }
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
