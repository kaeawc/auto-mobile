import type { RotationRestoreState } from "../features/action/RotationSupport";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { RotationOriginalsLedger } from "./rotationOriginalsLedger";

/**
 * This daemon's view of the {@link RotationOriginalsLedger} (#18847). Records written by an
 * earlier daemon process are loaded once at startup as orphans; the next session start on that
 * device takes the orphan and restores it like an abandoned release restore. Ledger operations
 * are serialized per device, and a failure never fails the rotation or the release: it is logged
 * and the in-memory restore continues as before.
 */
export class RotationOriginalsPersistence {
  private readonly orphans = new Map<string, RotationRestoreState>();
  private readonly chains = new Map<string, Promise<void>>();
  /** Devices whose stored record this daemon wrote; never orphans, even if preload reads them. */
  private readonly savedHere = new Set<string>();
  /** Devices retired in this process; a preload still in flight must not resurrect them. */
  private readonly retired = new Set<string>();
  private preloading: Promise<void> | undefined;

  constructor(private readonly ledger: RotationOriginalsLedger) {}

  /** Load the records an earlier daemon left behind; idempotent. */
  preload(): Promise<void> {
    this.preloading ??= this.ledger.loadAll().then(
      (records) => {
        for (const [deviceId, state] of records) {
          if (!this.savedHere.has(deviceId) && !this.retired.has(deviceId)) {
            this.orphans.set(deviceId, state);
          }
        }
      },
      (error: unknown) => {
        logger.warn(
          `Could not load saved rotation originals; a device left with auto-rotate off by an earlier daemon will not be restored: ${errorMessage(error)}`,
          error,
        );
      },
    );
    return this.preloading;
  }

  /** The record an earlier daemon left for this device, once; later calls return undefined. */
  takeOrphan(deviceId: string): RotationRestoreState | undefined {
    const state = this.orphans.get(deviceId);
    this.orphans.delete(deviceId);
    return state;
  }

  /** Persist a session's first originals before its first rotation write. */
  record(deviceId: string, state: RotationRestoreState): Promise<void> {
    return this.enqueue(deviceId, "save", async () => {
      if (await this.ledger.save(deviceId, state)) {
        this.savedHere.add(deviceId);
      }
    });
  }

  /** Drop the record once its settings are restored or definitively unrecoverable. */
  forget(deviceId: string, state: RotationRestoreState): Promise<void> {
    return this.enqueue(deviceId, "clear", () => this.ledger.clear(deviceId, state));
  }

  /**
   * The device was removed or its serial replaced: its record belongs to a device that is gone,
   * so it is deleted whatever it holds and is never restored onto the serial's next occupant.
   */
  retire(deviceId: string): Promise<void> {
    this.orphans.delete(deviceId);
    this.savedHere.delete(deviceId);
    this.retired.add(deviceId);
    return this.enqueue(deviceId, "remove", () => this.ledger.remove(deviceId));
  }

  private enqueue(deviceId: string, label: string, run: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(deviceId) ?? Promise.resolve()).then(run).catch((error) => {
      // Durability is best-effort: the in-memory restore still runs; only a restart loses it.
      logger.warn(
        `Failed to ${label} saved rotation originals for ${deviceId}; a daemon restart may not restore them: ${errorMessage(error)}`,
        error,
      );
    });
    this.chains.set(deviceId, next);
    void next.then(() => {
      if (this.chains.get(deviceId) === next) {
        this.chains.delete(deviceId);
      }
    });
    return next;
  }
}
