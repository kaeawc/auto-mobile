import type {
  ImeFlushOptions,
  PendingImeRestore,
  PendingImeRestoreRegistry,
} from "../../src/features/action/sendkeys/PendingImeRestore";

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
  store(deviceId: string, pending: PendingImeRestore): void {
    this.entries.set(deviceId, pending);
  }
  discard(deviceId: string): void {
    this.entries.delete(deviceId);
  }
  async flush(deviceId: string, options?: ImeFlushOptions): Promise<void> {
    this.flushes.push(deviceId);
    if (this.error) {
      throw this.error;
    }
    if (options?.isForced?.() || options?.signal?.aborted) {
      this.discard(deviceId);
      return;
    }
    await this.take(deviceId)?.restore();
  }
}
