import type {
  PendingImeRestore,
  PendingImeRestoreRegistry,
} from "../../src/features/action/sendkeys/PendingImeRestore";
import type { Timer } from "../../src/utils/SystemTimer";

export class FakePendingImeRestoreRegistry implements PendingImeRestoreRegistry {
  readonly entries = new Map<string, PendingImeRestore>();
  readonly flushes: string[] = [];
  error?: Error;
  hasPending(deviceId: string): boolean {
    return this.entries.has(deviceId);
  }
  take(deviceId: string): PendingImeRestore | undefined {
    const pending = this.entries.get(deviceId);
    this.entries.delete(deviceId);
    return pending;
  }
  store(deviceId: string, pending: PendingImeRestore, _timer: Timer): void {
    this.entries.set(deviceId, pending);
  }
  discard(deviceId: string): void {
    this.entries.delete(deviceId);
  }
  async flush(deviceId: string): Promise<void> {
    this.flushes.push(deviceId);
    if (this.error) {
      throw this.error;
    }
    await this.take(deviceId)?.restore();
  }
}
