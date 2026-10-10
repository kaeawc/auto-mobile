import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { Timer } from "../../utils/SystemTimer";
import {
  DeviceAssignedToManagedSlotError,
  ManagedSlotDiscoveryIncompleteError,
} from "./managedSlotRefusal";
import type { ManagedDeviceEntry, SlotPlatform, SlotRegistry } from "./slotRegistry";
import { openSqliteSlotRegistry } from "./sqliteSlotRegistry";

/**
 * A device as generic allocation sees it: its platform and every stable identity it is known by
 * (AVD name, simulator UDID, or a physical serial). Unknown identities are left out.
 */
export interface ManagedDeviceRef {
  platform: SlotPlatform;
  stableIds: ReadonlyArray<string | undefined>;
}

export interface ManagedSlotRefreshOptions {
  /** Reuse a snapshot younger than this. 0 (the default) always re-reads the registry. */
  maxAgeMs?: number;
}

/**
 * Generic-pool exclusion for managed slots (#11174 part b, #11178 part a): every device a managed
 * slot holds, idle or not, plus the managed free pool, read from the host-wide {@link SlotRegistry}.
 *
 * Lookups are synchronous against the last snapshot so the pool's hot path stays synchronous;
 * callers refresh first. An unreadable registry keeps the last good snapshot; when none was ever
 * loaded, refresh throws {@link ManagedSlotDiscoveryIncompleteError} instead of reporting "free".
 */
export interface ManagedSlotExclusion {
  refresh(options?: ManagedSlotRefreshOptions): Promise<void>;
  /** The managed entry holding the device, from the last snapshot. */
  holderOf(device: ManagedDeviceRef): ManagedDeviceEntry | undefined;
  /** Every stable id the last snapshot holds for `platform`, for selector-based boots. */
  stableIdsFor(platform: SlotPlatform): ReadonlySet<string>;
}

/**
 * The refusal for a caller that is not the slot's own live execution, or undefined when it may
 * proceed. Only the session recorded as the slot's execution owner may control its device; no
 * force flag or idle state overrides that.
 */
export function managedSlotRefusal(
  exclusion: ManagedSlotExclusion | undefined,
  input: {
    action: string;
    deviceId: string;
    device: ManagedDeviceRef;
    /** The caller's (base) session, when it has one. */
    requesterSessionUuid?: string;
  },
): DeviceAssignedToManagedSlotError | undefined {
  const entry = exclusion?.holderOf(input.device);
  if (!entry) {
    return undefined;
  }
  if (
    entry.holder === "slot" &&
    entry.execSessionUuid !== null &&
    input.requesterSessionUuid === entry.execSessionUuid
  ) {
    return undefined;
  }
  return new DeviceAssignedToManagedSlotError(input.action, input.deviceId, entry);
}

function entryKey(platform: SlotPlatform, stableId: string): string {
  return JSON.stringify([platform, stableId]);
}

interface LoadedSnapshot {
  byDevice: Map<string, ManagedDeviceEntry>;
  byPlatform: Map<SlotPlatform, Set<string>>;
  loadedAtMs: number;
}

export class RegistryManagedSlotExclusion implements ManagedSlotExclusion {
  private snapshot: LoadedSnapshot | undefined;
  private inFlight: Promise<void> | undefined;
  private registry: Promise<SlotRegistry> | undefined;

  constructor(
    private readonly openRegistry: () => Promise<SlotRegistry>,
    private readonly timer: Pick<Timer, "now">,
  ) {}

  async refresh(options: ManagedSlotRefreshOptions = {}): Promise<void> {
    const maxAgeMs = options.maxAgeMs ?? 0;
    if (
      maxAgeMs > 0 &&
      this.snapshot !== undefined &&
      this.timer.now() - this.snapshot.loadedAtMs < maxAgeMs
    ) {
      return;
    }
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  holderOf(device: ManagedDeviceRef): ManagedDeviceEntry | undefined {
    const byDevice = this.snapshot?.byDevice;
    if (!byDevice) {
      return undefined;
    }
    for (const stableId of device.stableIds) {
      const entry = stableId ? byDevice.get(entryKey(device.platform, stableId)) : undefined;
      if (entry) {
        return entry;
      }
    }
    return undefined;
  }

  stableIdsFor(platform: SlotPlatform): ReadonlySet<string> {
    return this.snapshot?.byPlatform.get(platform) ?? new Set();
  }

  private async load(): Promise<void> {
    let entries: ManagedDeviceEntry[];
    try {
      entries = await (await this.openRegistryOnce()).snapshotManagedDevices();
    } catch (error) {
      if (this.snapshot) {
        logger.warn(
          `[ManagedSlots] Registry unreadable; keeping the last snapshot: ${errorMessage(error)}`,
          error,
        );
        return;
      }
      throw new ManagedSlotDiscoveryIncompleteError(errorMessage(error));
    }
    const byDevice = new Map<string, ManagedDeviceEntry>();
    const byPlatform = new Map<SlotPlatform, Set<string>>();
    for (const entry of entries) {
      byDevice.set(entryKey(entry.platform, entry.stableDeviceId), entry);
      const ids = byPlatform.get(entry.platform) ?? new Set<string>();
      ids.add(entry.stableDeviceId);
      byPlatform.set(entry.platform, ids);
    }
    this.snapshot = { byDevice, byPlatform, loadedAtMs: this.timer.now() };
  }

  private openRegistryOnce(): Promise<SlotRegistry> {
    this.registry ??= this.openRegistry().catch((error: unknown) => {
      // Let the next refresh retry the open instead of caching the failure.
      this.registry = undefined;
      throw error;
    });
    return this.registry;
  }
}

let sharedHostRegistry: Promise<SlotRegistry> | undefined;

/**
 * The daemon's default: the host-wide SQLite registry, opened lazily on first use and shared by
 * every pool in this process. A failed open is retried on the next refresh.
 */
export function createDefaultManagedSlotExclusion(timer: Pick<Timer, "now">): ManagedSlotExclusion {
  return new RegistryManagedSlotExclusion(() => {
    sharedHostRegistry ??= openSqliteSlotRegistry().catch((error: unknown) => {
      sharedHostRegistry = undefined;
      throw error;
    });
    return sharedHostRegistry;
  }, timer);
}
