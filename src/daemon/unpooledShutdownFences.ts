export const UNPOOLED_SHUTDOWN_FENCE_HELD_MAX_MS = 600_000;
// Covers a discovery that began before the kill settled.
export const UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS = 30_000;

export class UnpooledShutdownFences {
  private readonly entries = new Map<string, { token: symbol; expiresAt: number }>();

  constructor(private readonly now: () => number) {}

  record(deviceId: string): symbol {
    const token = Symbol("unpooled-shutdown");
    this.entries.set(deviceId, {
      token,
      expiresAt: this.now() + UNPOOLED_SHUTDOWN_FENCE_HELD_MAX_MS,
    });
    return token;
  }

  /**
   * Shorten a held fence to the discovery grace once its kill has finished. Not token-scoped:
   * the per-device lifecycle lease serializes kills of one device until a late kill settles, so
   * no second kill's fence can be replaced here.
   */
  settle(deviceId: string): void {
    const entry = this.isActive(deviceId) ? this.entries.get(deviceId) : undefined;
    if (entry) {
      entry.expiresAt = this.now() + UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS;
    }
  }

  isActive(deviceId: string): boolean {
    const entry = this.entries.get(deviceId);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(deviceId);
      return false;
    }
    return true;
  }

  clear(deviceId: string, token?: symbol): void {
    if (token === undefined || this.entries.get(deviceId)?.token === token) {
      this.entries.delete(deviceId);
    }
  }
}
