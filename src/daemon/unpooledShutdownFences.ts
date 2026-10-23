export const UNPOOLED_SHUTDOWN_FENCE_HELD_MAX_MS = 600_000;
// Covers a discovery that began before the kill settled.
export const UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS = 30_000;

export class UnpooledShutdownFences {
  private readonly entries = new Map<string, { token: symbol; fenceEndsAt: number }>();

  constructor(private readonly now: () => number) {}

  record(deviceId: string): symbol {
    const token = Symbol("unpooled-shutdown");
    this.entries.set(deviceId, {
      token,
      fenceEndsAt: this.now() + UNPOOLED_SHUTDOWN_FENCE_HELD_MAX_MS,
    });
    return token;
  }

  /** Settle only this owner when a token is supplied; legacy callers settle the current hold. */
  settle(deviceId: string, token?: symbol): void {
    if (token !== undefined && this.entries.get(deviceId)?.token !== token) {
      return;
    }
    const entry = this.isActive(deviceId) ? this.entries.get(deviceId) : undefined;
    if (entry) {
      entry.fenceEndsAt = this.now() + UNPOOLED_SHUTDOWN_FENCE_LIFETIME_MS;
    }
  }

  isActive(deviceId: string): boolean {
    const entry = this.entries.get(deviceId);
    if (!entry) {
      return false;
    }
    if (entry.fenceEndsAt <= this.now()) {
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
