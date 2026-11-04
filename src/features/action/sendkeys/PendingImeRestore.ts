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
  /**
   * `signal` is the flush caller's ownership of the device: once it aborts, the restore must
   * issue no further device writes (#16580). Absent for an idle flush, which owns no session.
   */
  restore(signal?: AbortSignal): Promise<void>;
}

/** Bounds a flush for a caller that must not restore after it lost the device. */
export interface ImeFlushOptions {
  /**
   * Abandons the wait for the device IME lock, and fences every device write of a restore
   * already running: a forced release aborts it before the device returns to the pool.
   */
  signal?: AbortSignal;
  /** Rechecked once the lock is held: when true the pending restore is discarded, not run. */
  isForced?: () => boolean;
}

/** take/store run under the device IME lock; flush acquires it itself. */
export interface PendingImeRestoreRegistry {
  /** True while a restore is stored or being run: its device IME state is not yet settled. */
  hasPending(deviceId: string): boolean;
  take(deviceId: string): PendingImeRestore | undefined;
  store(deviceId: string, pending: PendingImeRestore, timer: Timer): void;
  flush(deviceId: string, options?: ImeFlushOptions): Promise<void>;
  discard(deviceId: string): void;
}

interface Entry {
  pending: PendingImeRestore;
  timer: Timer;
  handle: NodeJS.Timeout;
}

export class DevicePendingImeRestores implements PendingImeRestoreRegistry {
  private readonly entries = new Map<string, Entry>();
  /** Devices whose taken restore is still running under the IME lock; it cannot be cancelled. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly log: Pick<Logger, "warn"> = logger) {}

  hasPending(deviceId: string): boolean {
    return this.entries.has(deviceId) || this.inFlight.has(deviceId);
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

  flush(deviceId: string, options?: ImeFlushOptions): Promise<void> {
    return this.flushEntry(deviceId, undefined, options);
  }

  private async flushEntry(
    deviceId: string,
    expected?: Entry,
    options: ImeFlushOptions = {},
  ): Promise<void> {
    if (!expected && !this.hasPending(deviceId)) {
      return;
    }
    // A restore in flight holds the IME lock, so acquiring it here waits that restore out.
    await withAndroidImeLock(
      deviceId,
      async () => {
        // A timeout queued during a call cannot consume that call's newly reset timer.
        if (expected && this.entries.get(deviceId) !== expected) {
          return;
        }
        if (options.isForced?.() || options.signal?.aborted) {
          this.discard(deviceId);
          return;
        }
        const pending = this.take(deviceId);
        if (!pending) {
          return;
        }
        this.inFlight.add(deviceId);
        try {
          await pending.restore(options.signal);
        } finally {
          this.inFlight.delete(deviceId);
        }
      },
      options.signal,
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
