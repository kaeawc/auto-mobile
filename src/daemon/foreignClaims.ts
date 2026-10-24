import { exponentialBackoff, type BackoffPolicy } from "../utils/Backoff";
import { SingleFlight } from "../utils/cache/SingleFlight";
import { holderOf } from "./deviceBinding";
import type { Platform } from "../models";
import type { Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { DeviceOwnedByOtherDaemonError } from "../models/deviceAcquisitionRefusals";
import type { PooledDevice } from "./devicePool";
import type { ForeignDeviceOwnership } from "./foreignDeviceOwnership";

export interface ForeignClaimsPort {
  readonly foreignDeviceOwnership: ForeignDeviceOwnership | undefined;
  readonly iosForeignDeviceOwnership: ForeignDeviceOwnership | undefined;
  readonly timer: Pick<Timer, "now">;
  readonly inventoryProbeBackoff?: BackoffPolicy;
  getDevice(deviceId: string): Pick<PooledDevice, "sessionId"> | undefined;
  getDevicesByPlatform(platform?: Platform): PooledDevice[];
}

export class ForeignClaims {
  /** Last foreign owner PID logged per device, so a waiting allocation logs each owner once. */
  private readonly loggedForeignDeviceOwners = new Map<string, number>();
  /** `${platform}:${deviceId}` -> the latest foreign-claim read, shared within its max age. */
  private readonly foreignClaimSnapshots = new Map<
    string,
    { readAt: number; verdict: Promise<{ ownerPid: number | undefined; unreadable: boolean }> }
  >();

  private readonly inventoryFlight = new SingleFlight<string, void>();
  private readonly inventorySnapshots = new Map<
    string,
    { staleAt: number; foreign: boolean; streak: number }
  >();
  private readonly inventoryProbeBackoff: BackoffPolicy;

  constructor(private readonly port: ForeignClaimsPort) {
    this.inventoryProbeBackoff =
      port.inventoryProbeBackoff ??
      exponentialBackoff({ initialDelayMs: 1_000, multiplier: 2, maxDelayMs: 8_000 });
  }

  /** Inventory excludes only positively foreign Android serials, never our session holders. */
  async foreignSerials(
    serials: readonly string[],
    signal?: AbortSignal,
  ): Promise<ReadonlySet<string>> {
    signal?.throwIfAborted();
    const ownership = this.port.foreignDeviceOwnership;
    if (!ownership) {
      return new Set<string>();
    }
    const inventory = new Set(serials);
    for (const serial of this.inventorySnapshots.keys()) {
      if (!inventory.has(serial)) {
        this.inventorySnapshots.delete(serial);
      }
    }
    const missing = [...inventory].filter(
      (serial) =>
        (this.inventorySnapshots.get(serial)?.staleAt ?? -Infinity) <= this.port.timer.now(),
    );
    try {
      // Inventory evidence may be reused briefly; explicit binds still refresh afresh.
      if (missing.length > 0) {
        await this.inventoryFlight.run(
          JSON.stringify(missing.toSorted()),
          async (flightSignal) => {
            await ownership.refresh(missing, flightSignal);
            flightSignal?.throwIfAborted();
            for (const serial of missing) {
              const foreign = ownership.foreignOwnerPid(serial) !== undefined;
              const streak = foreign ? (this.inventorySnapshots.get(serial)?.streak ?? 0) + 1 : 0;
              this.inventorySnapshots.set(serial, {
                staleAt:
                  this.port.timer.now() + this.inventoryProbeBackoff.delayForAttempt(streak || 1),
                foreign,
                streak,
              });
            }
          },
          signal,
          { cancelWhenAllWaitersAbort: true },
        );
      }
      return new Set(
        serials.filter(
          (serial) =>
            this.inventorySnapshots.get(serial)?.foreign && !holderOf(this.port.getDevice(serial)),
        ),
      );
    } catch (error) {
      for (const serial of missing) {
        this.inventorySnapshots.delete(serial);
      }
      signal?.throwIfAborted();
      logger.warn(
        `[DevicePool] Android inventory ownership refresh failed: ${errorMessage(error)}`,
        error,
      );
      return new Set<string>();
    }
  }

  /** Who else drives devices of `platform`: Android by adb server, iOS by UDID (#10980). */
  foreignOwnershipFor(platform: Platform | undefined): ForeignDeviceOwnership | undefined {
    if (platform === "android") {
      return this.port.foreignDeviceOwnership;
    }
    return platform === "ios" ? this.port.iosForeignDeviceOwnership : undefined;
  }

  /** Whether allocation for `platform` (either, when unset) must honour other daemons' claims. */
  tracksForeignOwnership(platform?: Platform): boolean {
    return platform === undefined
      ? this.port.foreignDeviceOwnership !== undefined ||
          this.port.iosForeignDeviceOwnership !== undefined
      : this.foreignOwnershipFor(platform) !== undefined;
  }

  /**
   * An explicit bind (startDevice, setActiveDevice, getAndroid/getApple with a deviceId) of a
   * device this daemon does not already hold is refused while another live daemon claims it
   * (#10980, owner decision 2026-10-09): two daemons must never drive the same device. Lifecycle
   * tools that stop a device (killDevice, deleteDevice) apply the same check (#11200).
   *
   * Sessionless control (#11349) is frequent, so it passes `maxAgeMs`: calls within that window
   * share one read of the device's ownership, and so at most one relinquish request to its peer,
   * instead of a status query and a relinquish round trip each. A bind always reads afresh.
   */
  async assertNotClaimedByForeignDaemon(
    deviceId: string,
    platform: Platform,
    remedy?: string,
    maxAgeMs = 0,
  ): Promise<void> {
    const ownership = this.foreignOwnershipFor(platform);
    if (!ownership || holderOf(this.port.getDevice(deviceId))) {
      return;
    }
    const key = `${platform}:${deviceId}`;
    const cached = this.foreignClaimSnapshots.get(key);
    const snapshot =
      cached && this.port.timer.now() - cached.readAt < maxAgeMs
        ? cached
        : { readAt: this.port.timer.now(), verdict: this.readForeignClaim(ownership, deviceId) };
    if (snapshot !== cached) {
      this.foreignClaimSnapshots.set(key, snapshot);
      // A failed read is not a verdict: the next call reads again.
      void snapshot.verdict.catch((error: unknown) => {
        // The awaiting caller surfaces the error; here it only drops the unusable snapshot.
        logger.debug(
          `[DevicePool] foreign-claim read of ${deviceId} failed: ${errorMessage(error)}`,
        );
        if (this.foreignClaimSnapshots.get(key) === snapshot) {
          this.foreignClaimSnapshots.delete(key);
        }
      });
    }
    const { ownerPid, unreadable } = await snapshot.verdict;
    if (ownerPid !== undefined || unreadable) {
      throw new DeviceOwnedByOtherDaemonError(deviceId, ownerPid, remedy);
    }
  }

  /** Who else holds `deviceId` right now, after asking an idle lease-only peer to let go. */
  async readForeignClaim(
    ownership: ForeignDeviceOwnership,
    deviceId: string,
  ): Promise<{ ownerPid: number | undefined; unreadable: boolean }> {
    await ownership.refresh([deviceId]);
    if (ownership.foreignOwnerPid(deviceId) !== undefined) {
      // A peer that only holds an idle CtrlProxy forwarding lease is asked to give it up before
      // the device is refused; it stays the owner when it declines (#11349).
      await ownership.relinquishIdleLease?.(deviceId);
    }
    return {
      ownerPid: ownership.foreignOwnerPid(deviceId),
      unreadable: ownership.foreignClaimUnreadable?.(deviceId) === true,
    };
  }

  countForeignDrivenDevices(platform?: Platform): number {
    return this.port
      .getDevicesByPlatform(platform)
      .filter((device) => this.isDrivenByForeignDaemon(device)).length;
  }

  /**
   * An idle Android device whose CtrlProxy forwarding lease another live AutoMobile process holds
   * is that process's device. On a shared adb server it looks idle here only because this pool
   * holds no session on it, so multi-device allocation must not hand it to a plan.
   */
  isDrivenByForeignDaemon(device: PooledDevice): boolean {
    if (holderOf(device) !== null) {
      return false;
    }
    const ownership = this.foreignOwnershipFor(device.platform);
    const ownerPid = ownership?.foreignOwnerPid(device.id);
    if (ownerPid === undefined) {
      this.loggedForeignDeviceOwners.delete(device.id);
      // An unreadable claim names no owner but is not free either.
      return ownership?.foreignClaimUnreadable?.(device.id) === true;
    }
    if (this.loggedForeignDeviceOwners.get(device.id) !== ownerPid) {
      this.loggedForeignDeviceOwners.set(device.id, ownerPid);
      logger.info(
        `[DevicePool] Not allocating ${device.id}: another AutoMobile process (PID ${ownerPid}) drives it`,
      );
    }
    return true;
  }
}
