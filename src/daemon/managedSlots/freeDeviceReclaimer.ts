/**
 * Free-pool device reclamation (#11337, epic #11172).
 *
 * Owner decision 2026-10-10: a free-pool device that no slot adopts within one hour is SHUT DOWN
 * but its image is KEPT, so a later slot with a matching spec can adopt it cheaply. It is not
 * deleted and it is not returned to the generic pool (it stays excluded from generic use).
 *
 * A periodic daemon sweep, on the injected timer, takes every free-pool row unadopted for the
 * threshold (the registry's `freed_at_ms`, so the clock survives a daemon restart) and, for each:
 *
 * 1. Skips it unless it is a configured device this daemon created (generated managed name), no
 *    session holds it, no other daemon claims it and the injected `isBusy` finds no in-flight boot,
 *    control call or lifecycle operation on it.
 * 2. Claims it with a compare-and-set to `stopping` (adoption of a `stopping` row is refused, and an
 *    adoption that already deleted the row makes the claim fail, so an adoption racing the sweep
 *    keeps its device).
 * 3. Shuts it down through the injected lifecycle port, then records `stopped` with a second CAS.
 *    The row stays, so a matching slot adopts it and its provision path boots it through the normal
 *    boot-capacity gate.
 *
 * The `stopping` row records the claiming daemon and time; only the claimer, or another daemon once
 * the claim is stale, drives the stop, and adoption is refused only while a claim is live. A crash
 * between 2 and 3 therefore leaves a claim that goes stale and is re-driven by the next daemon. A
 * failed shutdown reverts the row to `free` at once (the device stays adoptable), is logged, and is
 * retried with {@link Backoff} per device; it never loops hot. Single-flight: concurrent
 * callers share the in-flight sweep.
 */

import {
  exponentialBackoff,
  normalizeBackoff,
  type BackoffInput,
  type BackoffPolicy,
} from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type { DeviceInfo } from "../../models";
import {
  MANAGED_SLOT_DEVICE_NAME_PREFIX,
  type ManagedSlotDeviceClaims,
  type ManagedSlotInventory,
} from "./reconciler";
import { deviceStableId } from "./slotDeviceIdentity";
import type { ManagedSlotCacheEvictor } from "./managedSlotCacheEviction";
import { resolveAbandonmentThresholdMs } from "./slotRegistry";
import type {
  AbandonmentQuery,
  FreeDeviceStopClaim,
  FreeSlotDeviceRecord,
  SlotPlatform,
  SlotRegistry,
} from "./slotRegistry";

/** How often the daemon looks for unadopted free-pool devices. The threshold itself is one hour. */
export const FREE_DEVICE_RECLAIM_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export const DEFAULT_FREE_DEVICE_STOP_BACKOFF = exponentialBackoff({
  initialDelayMs: 30_000,
  multiplier: 2,
  maxDelayMs: 30 * 60 * 1000,
});

export type FreeDeviceReclaimRegistry = Pick<
  SlotRegistry,
  | "listFreeDevices"
  | "findReclaimableFreeDevices"
  | "beginFreeDeviceStop"
  | "holdsFreeDeviceStop"
  | "completeFreeDeviceStop"
  | "revertFreeDeviceStop"
>;

export interface ManagedSlotStopTarget {
  platform: SlotPlatform;
  stableId: string;
  name: string;
  /** The free-pool row's source scope, for the lifecycle guard's slot context. */
  fromScopeKey: string;
  /**
   * Whether the registry row is still `stopping` under this sweep's claim. The stopper checks it
   * immediately before it shuts the device down: the registry row, not the slot context the stopper
   * runs under, is the authority that the device was not adopted meanwhile.
   */
  stillClaimed(): Promise<boolean>;
}

/** `stopped` only when the device is verified not running; anything else is `failed`. */
export type ManagedSlotStopResult =
  | { kind: "stopped"; evidence?: unknown }
  | { kind: "failed"; message: string; evidence?: unknown };

/** Shuts a device down and keeps its image (`killDevice`, never `deleteDevice`). */
export interface ManagedSlotDeviceStopper {
  stopAndVerifyOffline(target: ManagedSlotStopTarget): Promise<ManagedSlotStopResult>;
}

export interface FreeDeviceReclaimSkip {
  platform: SlotPlatform;
  stableDeviceId: string;
  reason: string;
}

export interface FreeDeviceSweepReport {
  /** Devices shut down and recorded `stopped`. */
  stopped: Array<{ platform: SlotPlatform; stableDeviceId: string }>;
  /** Verified-absent rows released through the deletion journal. */
  released: Array<{ platform: SlotPlatform; stableDeviceId: string }>;
  failed: Array<{ platform: SlotPlatform; stableDeviceId: string; message: string }>;
  skipped: FreeDeviceReclaimSkip[];
}

export interface FreeDeviceReclaimerOptions {
  registry: () => Promise<FreeDeviceReclaimRegistry>;
  /**
   * Whether the registry exists. While it does not, nothing can be reclaimed and the sweep does
   * not open (and so create) it. Defaults to always existing.
   */
  registryExists?: () => boolean;
  inventory: ManagedSlotInventory;
  claims: Pick<ManagedSlotDeviceClaims, "describe" | "sessionsOn">;
  stopper: ManagedSlotDeviceStopper;
  /**
   * A reason the device must be left alone right now (an in-flight boot, a lifecycle lease, a
   * shutdown or restart-recovery reservation), or undefined when it is quiet.
   */
  isBusy?: (device: DeviceInfo) => string | undefined;
  timer: Pick<Timer, "now" | "setInterval" | "clearInterval">;
  /** This daemon's id, recorded on every `stopping` claim it makes. */
  claimedBy: string;
  intervalMs?: number;
  /** Retry delay after a failed shutdown, per device. */
  backoff?: BackoffInput;
  /** Unadopted threshold; defaults to the registry's one hour. */
  reclaim?: AbandonmentQuery;
  /** Resolved per sweep; no journal means absent rows retain their charge. */
  absentRowEvictor?: (
    registry: FreeDeviceReclaimRegistry,
  ) => Pick<ManagedSlotCacheEvictor, "evict"> | undefined;
}

function emptyReport(): FreeDeviceSweepReport {
  return { stopped: [], released: [], failed: [], skipped: [] };
}

function deviceKey(device: { platform: SlotPlatform; stableDeviceId: string }): string {
  return JSON.stringify([device.platform, device.stableDeviceId]);
}

interface FailureRecord {
  attempts: number;
  retryAtMs: number;
}

export class FreeDeviceReclaimer {
  private interval: NodeJS.Timeout | undefined;
  private running: Promise<FreeDeviceSweepReport> | undefined;
  private readonly failures = new Map<string, FailureRecord>();
  private readonly backoff: BackoffPolicy;
  private readonly absentRows = new Set<string>();

  constructor(private readonly options: FreeDeviceReclaimerOptions) {
    this.backoff = normalizeBackoff(options.backoff ?? DEFAULT_FREE_DEVICE_STOP_BACKOFF);
  }

  start(): void {
    if (this.interval) {
      return;
    }
    this.interval = this.options.timer.setInterval(() => {
      this.sweep().catch((error: unknown) => {
        logger.warn(`[ManagedSlots] Free-pool reclaim sweep failed: ${errorMessage(error)}`, error);
      });
    }, this.options.intervalMs ?? FREE_DEVICE_RECLAIM_SWEEP_INTERVAL_MS);
    // A periodic sweep must never keep the daemon process alive on its own.
    const handle = this.interval as { unref?: () => void };
    if (typeof handle.unref === "function") {
      handle.unref();
    }
  }

  stop(): void {
    if (this.interval) {
      this.options.timer.clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /** One sweep; concurrent callers share the in-flight one. */
  sweep(): Promise<FreeDeviceSweepReport> {
    this.running ??= this.runSweep().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runSweep(): Promise<FreeDeviceSweepReport> {
    const report = emptyReport();
    if (this.options.registryExists?.() === false) {
      return report;
    }
    const registry = await this.options.registry();
    const due = await registry.findReclaimableFreeDevices(this.options.reclaim);
    const inventories = new Map<SlotPlatform, Promise<DeviceInfo[] | undefined>>();
    const devicesOf = (platform: SlotPlatform): Promise<DeviceInfo[] | undefined> => {
      let listing = inventories.get(platform);
      if (!listing) {
        listing = this.listConfigured(platform);
        inventories.set(platform, listing);
      }
      return listing;
    };
    const evictor = this.options.absentRowEvictor?.(registry);
    const handled = evictor
      ? await this.releaseAbsentRows(registry, evictor, devicesOf, report)
      : new Set<string>();
    for (const free of due) {
      if (handled.has(deviceKey(free))) {
        continue;
      }
      await this.reclaimOne(registry, free, await devicesOf(free.platform), report);
    }
    return report;
  }

  private async releaseAbsentRows(
    registry: FreeDeviceReclaimRegistry,
    evictor: Pick<ManagedSlotCacheEvictor, "evict">,
    devicesOf: (platform: SlotPlatform) => Promise<DeviceInfo[] | undefined>,
    report: FreeDeviceSweepReport,
  ): Promise<Set<string>> {
    const rows = await registry.listFreeDevices();
    const identities = new Set(rows.map((row) => this.absenceIdentity(row)));
    for (const identity of this.absentRows) {
      if (!identities.has(identity)) {
        this.absentRows.delete(identity);
      }
    }
    const cutoff = this.options.timer.now() - resolveAbandonmentThresholdMs(this.options.reclaim);
    const eligible = rows.filter(
      (row) =>
        row.freedAtMs <= cutoff &&
        row.deletion === null &&
        (row.state === "free" || row.state === "stopped"),
    );
    const handled = new Set<string>();
    for (const row of eligible) {
      const devices = await devicesOf(row.platform);
      const identity = this.absenceIdentity(row);
      if (devices?.some((device) => deviceStableId(device) === row.stableDeviceId)) {
        this.absentRows.delete(identity);
        continue;
      }
      handled.add(deviceKey(row));
      if (!devices) {
        report.skipped.push({ ...this.rowIdentity(row), reason: "discovery_incomplete" });
      } else if (!this.absentRows.has(identity)) {
        this.absentRows.add(identity);
        report.skipped.push({ ...this.rowIdentity(row), reason: "absence_unconfirmed" });
      } else {
        await this.releaseAbsentRow(evictor, row, report);
      }
    }
    return handled;
  }

  private absenceIdentity(row: FreeSlotDeviceRecord): string {
    return JSON.stringify([row.platform, row.stableDeviceId, row.fromScopeKey, row.freedAtMs]);
  }

  private rowIdentity(row: FreeSlotDeviceRecord): {
    platform: SlotPlatform;
    stableDeviceId: string;
  } {
    return { platform: row.platform, stableDeviceId: row.stableDeviceId };
  }

  private async releaseAbsentRow(
    evictor: Pick<ManagedSlotCacheEvictor, "evict">,
    row: FreeSlotDeviceRecord,
    report: FreeDeviceSweepReport,
  ): Promise<void> {
    try {
      const result = await evictor.evict(
        {
          ...this.rowIdentity(row),
          fromScopeKey: row.fromScopeKey,
          freedAtMs: row.freedAtMs,
          name: row.stableDeviceId,
          lastUsedAtMs: row.freedAtMs,
          absent: true,
        },
        {},
      );
      if (result.kind === "absent") {
        this.absentRows.delete(this.absenceIdentity(row));
        report.released.push(this.rowIdentity(row));
        logger.info(
          `[ManagedSlots] Released verified-absent free-pool row '${row.stableDeviceId}'`,
        );
      } else if (result.kind === "lost") {
        this.absentRows.delete(this.absenceIdentity(row));
        report.skipped.push({ ...this.rowIdentity(row), reason: "row_moved" });
      } else {
        report.failed.push({ ...this.rowIdentity(row), message: result.message });
      }
    } catch (error) {
      logger.warn(
        `[ManagedSlots] Absent free-pool row release failed: ${errorMessage(error)}`,
        error,
      );
      report.failed.push({ ...this.rowIdentity(row), message: errorMessage(error) });
    }
  }

  private async listConfigured(platform: SlotPlatform): Promise<DeviceInfo[] | undefined> {
    try {
      const snapshot = await this.options.inventory.list(platform, {});
      return snapshot.complete ? snapshot.devices : undefined;
    } catch (error) {
      logger.warn(
        `[ManagedSlots] Free-pool reclaim could not list ${platform} devices: ${errorMessage(error)}`,
        error,
      );
      return undefined;
    }
  }

  private async reclaimOne(
    registry: FreeDeviceReclaimRegistry,
    free: FreeSlotDeviceRecord,
    devices: DeviceInfo[] | undefined,
    report: FreeDeviceSweepReport,
  ): Promise<void> {
    const key = deviceKey(free);
    const skip = (reason: string): void => {
      report.skipped.push({
        platform: free.platform,
        stableDeviceId: free.stableDeviceId,
        reason,
      });
    };
    const failure = this.failures.get(key);
    const reason = await this.skipReason(free, devices, failure);
    if (typeof reason === "string") {
      skip(reason);
      return;
    }
    const device = reason;
    const claim: FreeDeviceStopClaim = { ...free, claimedBy: this.options.claimedBy };
    const begun = await registry.beginFreeDeviceStop(claim, this.options.reclaim);
    if (begun.kind !== "begun") {
      skip("not_reclaimable");
      return;
    }
    // A device the inventory established as not running needs no shutdown; its row still moves to
    // `stopped` so it is not re-examined every sweep.
    const result: ManagedSlotStopResult =
      device.isRunning === false && device.isRunningStateKnown !== false
        ? { kind: "stopped" }
        : await this.stopDevice(registry, claim, device);
    if (result.kind === "failed") {
      await this.recordFailure(registry, claim, device, result.message, report);
      return;
    }
    this.failures.delete(key);
    if (!(await registry.completeFreeDeviceStop(claim))) {
      // An adoption or reset moved the row while it shut down; the registry is the authority.
      skip("row_moved");
      return;
    }
    logger.info(
      `[ManagedSlots] Free-pool device '${device.name}' unadopted past the threshold: shut down, image kept`,
    );
    report.stopped.push({ platform: free.platform, stableDeviceId: free.stableDeviceId });
  }

  /**
   * A failed shutdown never leaves the device unadoptable: the claim is reverted to `free` right
   * away (a no-op when the claim was already lost), the failure is backed off per device, and a
   * later sweep tries again. Warned once; later failures of the same device are debug only.
   */
  private async recordFailure(
    registry: FreeDeviceReclaimRegistry,
    claim: FreeDeviceStopClaim,
    device: DeviceInfo,
    message: string,
    report: FreeDeviceSweepReport,
  ): Promise<void> {
    const key = deviceKey(claim);
    const attempts = (this.failures.get(key)?.attempts ?? 0) + 1;
    this.failures.set(key, {
      attempts,
      retryAtMs: this.options.timer.now() + this.backoff.delayForAttempt(attempts),
    });
    const text = `Shutting down unadopted free-pool device '${device.name}' failed (attempt ${attempts}): ${message}; it stays adoptable`;
    if (attempts === 1) {
      logger.warn(`[ManagedSlots] ${text}`);
    } else {
      logger.debug(`[ManagedSlots] ${text}`);
    }
    try {
      await registry.revertFreeDeviceStop(claim);
    } catch (error) {
      // The claim goes stale on its own (FREE_DEVICE_STOP_CLAIM_STALE_MS), which frees the device.
      logger.warn(`[ManagedSlots] Could not revert the stop claim: ${errorMessage(error)}`, error);
    }
    report.failed.push({ platform: claim.platform, stableDeviceId: claim.stableDeviceId, message });
  }

  /** Why this device is left alone this sweep, or the configured device when it is reclaimable. */
  private async skipReason(
    free: FreeSlotDeviceRecord,
    devices: DeviceInfo[] | undefined,
    failure: FailureRecord | undefined,
  ): Promise<string | DeviceInfo> {
    if (failure && this.options.timer.now() < failure.retryAtMs) {
      return "backoff";
    }
    if (!devices) {
      return "discovery_incomplete";
    }
    const device = devices.find(
      (candidate) =>
        candidate.platform === free.platform && deviceStableId(candidate) === free.stableDeviceId,
    );
    if (!device) {
      return "not_in_inventory";
    }
    this.absentRows.delete(this.absenceIdentity(free));
    // Only a device this daemon created is ours to shut down; boot capacity counts the others.
    if (!device.name.startsWith(MANAGED_SLOT_DEVICE_NAME_PREFIX)) {
      return "not_daemon_created";
    }
    return (await this.holdReason(device)) ?? device;
  }

  /** Why the device must not be touched right now, or undefined when it is quiet. */
  private async holdReason(device: DeviceInfo): Promise<string | undefined> {
    const { claims } = this.options;
    if ((claims.sessionsOn?.(device) ?? []).length > 0) {
      return "session_holds_device";
    }
    const claim = await claims.describe(device);
    if (claim.kind === "held") {
      return "held";
    }
    if (claim.kind === "unknown") {
      return "claim_unknown";
    }
    return this.options.isBusy?.(device) === undefined ? undefined : "busy";
  }

  private async stopDevice(
    registry: FreeDeviceReclaimRegistry,
    claim: FreeDeviceStopClaim,
    device: DeviceInfo,
  ): Promise<ManagedSlotStopResult> {
    try {
      return await this.options.stopper.stopAndVerifyOffline({
        platform: claim.platform,
        stableId: claim.stableDeviceId,
        name: device.name,
        fromScopeKey: claim.fromScopeKey,
        stillClaimed: () => registry.holdsFreeDeviceStop(claim),
      });
    } catch (error) {
      // An unverified shutdown is a failed shutdown: the device may still be running.
      return { kind: "failed", message: errorMessage(error) };
    }
  }
}
