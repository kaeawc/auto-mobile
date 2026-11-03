import { withAndroidImeLock } from "../androidImeLock";
import type { ImeSpanSnapshot } from "./ImeSpan";
import type { Timer } from "../../../utils/SystemTimer";
import { registerDeviceIncarnationListener } from "../../../utils/deviceIncarnation";
import { logger, type Logger } from "../../../utils/logger";

/** Consecutive typing calls share an activation for up to five idle seconds. */
export const IME_IDLE_RESTORE_MS = 5_000;

export interface PendingImeRestore {
  snapshot: ImeSpanSnapshot;
  userId: number | undefined;
  restore(): Promise<void>;
}

/** take/store run under the device IME lock; flush acquires it itself. */
export interface PendingImeRestoreRegistry {
  hasPending(deviceId: string): boolean;
  take(deviceId: string): PendingImeRestore | undefined;
  store(deviceId: string, pending: PendingImeRestore, timer: Timer): void;
  flush(deviceId: string): Promise<void>;
  discard(deviceId: string): void;
}

interface Entry {
  pending: PendingImeRestore;
  timer: Timer;
  handle: NodeJS.Timeout;
}

export class DevicePendingImeRestores implements PendingImeRestoreRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly log: Pick<Logger, "warn"> = logger) {}

  hasPending(deviceId: string): boolean {
    return this.entries.has(deviceId);
  }

  take(deviceId: string): PendingImeRestore | undefined {
    const entry = this.entries.get(deviceId);
    if (!entry) {
      return undefined;
    }
    entry.timer.clearTimeout(entry.handle);
    this.entries.delete(deviceId);
    return entry.pending;
  }

  store(deviceId: string, pending: PendingImeRestore, timer: Timer): void {
    this.discard(deviceId);
    const handle = timer.setTimeout(() => {
      void this.flushEntry(deviceId, entry).catch((error: unknown) => {
        this.log.warn(`[SendKeys] Idle IME restoration failed on ${deviceId}`, error);
      });
    }, IME_IDLE_RESTORE_MS);
    handle.unref?.();
    const entry = { pending, timer, handle };
    this.entries.set(deviceId, entry);
  }

  discard(deviceId: string): void {
    this.take(deviceId);
  }

  flush(deviceId: string): Promise<void> {
    return this.flushEntry(deviceId);
  }

  private async flushEntry(deviceId: string, expected?: Entry): Promise<void> {
    if (!expected && !this.entries.has(deviceId)) {
      return;
    }
    await withAndroidImeLock(
      deviceId,
      async () => {
        // A timeout queued during a call cannot consume that call's newly reset timer.
        if (expected && this.entries.get(deviceId) !== expected) {
          return;
        }
        await this.take(deviceId)?.restore();
      },
      undefined,
      { allowQuarantined: true },
    );
  }
}

export const pendingImeRestores: PendingImeRestoreRegistry = new DevicePendingImeRestores();

registerDeviceIncarnationListener({
  name: "pending-ime-restore",
  onDeviceIdentityReplaced: (deviceId) => pendingImeRestores.discard(deviceId),
  onDeviceIncarnationChanged: () => {},
});
