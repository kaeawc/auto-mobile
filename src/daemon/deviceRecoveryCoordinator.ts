import type { DeviceInfo } from "../models";
import type { Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import type { AndroidRecoveryRecord } from "./androidRecoveryRecordLedger";

const RECOVERING_IMAGE_SETTLEMENT_MISSING_RETRY_MS = 250;

interface RecoveringAndroidImageSettlement {
  settled: Promise<void>;
  resolve(): void;
}

export interface DeviceRecoveryPoolPort {
  getRecoveringSessionLosses(): ReadonlyMap<string, AndroidRecoveryRecord>;
  getTimer(): Timer;
}

/** Tracks Android recovery image and handoff ownership while the pool retains assignment state. */
export class DeviceRecoveryCoordinator {
  readonly recoveringAndroidImages: Map<string, DeviceInfo> = new Map();
  readonly recoveringAndroidDeviceIds: Set<string> = new Set();
  readonly androidRecoveryHandoffOwners = new Map<string, symbol>();
  readonly recoveringAndroidImageSettlements: Map<string, RecoveringAndroidImageSettlement> =
    new Map();

  constructor(private readonly pool: DeviceRecoveryPoolPort) {}

  addRecoveringAndroidDeviceId(deviceId: string): void {
    this.recoveringAndroidDeviceIds.add(deviceId);
  }

  setAndroidRecoveryHandoffOwner(deviceId: string, handoffOwner: symbol): void {
    this.androidRecoveryHandoffOwners.set(deviceId, handoffOwner);
  }

  clearAndroidRecoveryHandoffOwnerIfCurrent(deviceId: string, owner: symbol): void {
    if (this.androidRecoveryHandoffOwners.get(deviceId) === owner) {
      this.androidRecoveryHandoffOwners.delete(deviceId);
    }
  }

  finishAndroidRecoveryAttempt(
    avdName: string,
    recoveryDeviceIds: ReadonlySet<string>,
    retainRecoveryImage: boolean,
    replacementHandoffOwner: symbol,
  ): void {
    for (const [deviceId, owner] of this.androidRecoveryHandoffOwners) {
      if (owner === replacementHandoffOwner) {
        this.androidRecoveryHandoffOwners.delete(deviceId);
      }
    }
    const recordOwnsImage = Array.from(this.pool.getRecoveringSessionLosses().values()).some(
      (record) => record.avdName === avdName && record.reservations.has("image"),
    );
    if (!retainRecoveryImage && !recordOwnsImage) {
      this.clearRecoveringAndroidImage(avdName);
    }
    for (const deviceId of recoveryDeviceIds) {
      this.recoveringAndroidDeviceIds.delete(deviceId);
    }
  }

  setRecoveringAndroidImage(avdName: string, image: DeviceInfo): void {
    this.recoveringAndroidImages.set(avdName, image);
    if (this.recoveringAndroidImageSettlements.has(avdName)) {
      return;
    }
    let resolve!: () => void;
    const settled = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    this.recoveringAndroidImageSettlements.set(avdName, { settled, resolve });
  }

  clearRecoveringAndroidImage(avdName: string): void {
    this.recoveringAndroidImages.delete(avdName);
    const settlement = this.recoveringAndroidImageSettlements.get(avdName);
    if (!settlement) {
      return;
    }
    this.recoveringAndroidImageSettlements.delete(avdName);
    settlement.resolve();
  }

  async waitForRecoveringAndroidImages(
    avdNames: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const settlements = avdNames.flatMap((avdName) => {
      const settlement = this.recoveringAndroidImageSettlements.get(avdName);
      return settlement ? [settlement.settled] : [];
    });
    if (settlements.length === 0) {
      if (!avdNames.some((avdName) => this.recoveringAndroidImages.has(avdName))) {
        return;
      }
      // The maps should be updated together; a short retry safely handles any transient inconsistency.
      logger.debug(
        `[DevicePool] Recovering Android AVD image was observed without a tracked settlement; retrying`,
      );
      await this.waitForAndroidRecoveryDelay(RECOVERING_IMAGE_SETTLEMENT_MISSING_RETRY_MS, signal);
      return;
    }
    await this.waitForRecoverySettlements(settlements, signal);
  }

  async waitForRecoverySettlements(
    settlements: readonly Promise<void>[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (settlements.length === 0) {
      return;
    }
    let abortListener: (() => void) | undefined;
    const cancellation = signal
      ? new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(signal.reason ?? new Error("Device preparation cancelled"));
          if (signal.aborted) {
            abortListener();
            return;
          }
          signal.addEventListener("abort", abortListener, { once: true });
        })
      : undefined;
    try {
      await Promise.race([Promise.all(settlements), ...(cancellation ? [cancellation] : [])]);
    } finally {
      if (abortListener) {
        signal?.removeEventListener("abort", abortListener);
      }
    }
  }

  private async waitForAndroidRecoveryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await this.pool.getTimer().sleep(delayMs);
      return;
    }
    let abortListener: (() => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(signal.reason ?? new Error("Device preparation cancelled"));
      if (signal.aborted) {
        abortListener();
        return;
      }
      signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      await Promise.race([this.pool.getTimer().sleep(delayMs), cancellation]);
    } finally {
      if (abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  isAndroidRecoveryHandoffReserved(deviceId: string, allowedOwners?: ReadonlySet<symbol>): boolean {
    const owner = this.androidRecoveryHandoffOwners.get(deviceId);
    return owner !== undefined && !allowedOwners?.has(owner);
  }
}
