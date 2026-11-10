import { withAndroidImeLock } from "../androidImeLock";
import type { ImeSpanSnapshot } from "./ImeSpan";
import { registerDeviceIncarnationListener } from "../../../utils/deviceIncarnation";

export interface PendingImeRestore {
  snapshot: ImeSpanSnapshot;
  userId: number | undefined;
  /**
   * `signal` is the flush caller's ownership of the device: once it aborts, the restore must
   * issue no further device writes (#16580). Absent for a flush that owns no session.
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

/**
 * The keyboard a device session replaced with the AutoMobile IME, kept until session release
 * (#16428): typing calls never restore it, so no per-call IME swap hides the keyboard.
 * take/store run under the device IME lock; flush acquires it itself.
 */
export interface PendingImeRestoreRegistry {
  /** True while a restore is stored or being run: its device IME state is not yet settled. */
  hasPending(deviceId: string): boolean;
  take(deviceId: string): PendingImeRestore | undefined;
  store(deviceId: string, pending: PendingImeRestore): void;
  flush(deviceId: string, options?: ImeFlushOptions): Promise<void>;
  discard(deviceId: string): void;
}

export class DevicePendingImeRestores implements PendingImeRestoreRegistry {
  private readonly entries = new Map<string, PendingImeRestore>();
  /** Devices whose taken restore is still running under the IME lock; it cannot be cancelled. */
  private readonly inFlight = new Set<string>();

  hasPending(deviceId: string): boolean {
    return this.entries.has(deviceId) || this.inFlight.has(deviceId);
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
    this.take(deviceId);
  }

  async flush(deviceId: string, options: ImeFlushOptions = {}): Promise<void> {
    if (!this.hasPending(deviceId)) {
      return;
    }
    // A restore in flight holds the IME lock, so acquiring it here waits that restore out.
    await withAndroidImeLock(
      deviceId,
      async () => {
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
