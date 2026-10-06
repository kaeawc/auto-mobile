import type { BootedDevice } from "../models";
import { displayInventoryOutcome, type DisplayInventoryOutcome } from "../models/DeviceInfo";
import type { DeviceDisplays } from "../models/DisplayPanel";
import type { AdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { readAndroidDeviceDisplaysChecked } from "../utils/android-cmdline-tools/AndroidDisplayInventory";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { awaitWhileRequestIsLive } from "../utils/toolUtils";

export interface DisplayInventoryProvider {
  hydrate(device: BootedDevice, identityToken: string, signal?: AbortSignal): Promise<BootedDevice>;
  invalidate(deviceId: string): void;
}

export interface DisplayInventorySource {
  read(device: BootedDevice): Promise<{
    displays?: DeviceDisplays;
    degraded: boolean;
    outcome?: DisplayInventoryOutcome;
  }>;
}

interface InventoryEntry {
  token: string;
  displays: DeviceDisplays | null;
  outcome?: DisplayInventoryOutcome;
  retryAt?: number;
  pending?: Promise<void>;
}

/** Extra reads a hydrate may start when a display event invalidates the inventory mid-read. */
const MAX_INVENTORY_REREADS = 2;

function hasReadInventory(entry: InventoryEntry): boolean {
  return entry.outcome !== undefined && entry.outcome.kind !== "unreadable";
}

export class CachingDisplayInventoryProvider implements DisplayInventoryProvider {
  private readonly entries = new Map<string, InventoryEntry>();

  constructor(
    private readonly androidSource: DisplayInventorySource,
    private readonly iosSource: DisplayInventorySource,
    private readonly timer: Pick<Timer, "now"> = defaultTimer,
    private readonly degradedRetryMs = 5_000,
    private readonly failureRetryMs = 30_000,
  ) {}

  async hydrate(
    device: BootedDevice,
    identityToken: string,
    signal?: AbortSignal,
  ): Promise<BootedDevice> {
    if (device.displays?.panels.length) {
      return device;
    }
    const key = `${device.platform}:${device.deviceId}`;
    const reads: InventoryEntry[] = [];
    // A display push that invalidates the entry mid-read must not leave this call without an
    // inventory: re-read, bounded so an event storm cannot loop, and fall back to what was read.
    for (let attempt = 0; attempt <= MAX_INVENTORY_REREADS; attempt++) {
      const entry = await this.acquire(key, device, identityToken, signal);
      reads.push(entry);
      if (this.entries.get(key) === entry) {
        break;
      }
    }
    const entry = reads.findLast(hasReadInventory) ?? reads[reads.length - 1];
    return {
      ...device,
      ...(entry.displays ? { displays: entry.displays } : {}),
      ...(entry.outcome ? { [displayInventoryOutcome]: entry.outcome } : {}),
    };
  }

  private async acquire(
    key: string,
    device: BootedDevice,
    identityToken: string,
    signal?: AbortSignal,
  ): Promise<InventoryEntry> {
    let entry = this.entries.get(key);
    if (!entry || entry.token !== identityToken) {
      entry = { token: identityToken, displays: null };
      this.entries.set(key, entry);
      entry.pending = this.fetch(key, entry, device);
      await awaitWhileRequestIsLive(entry.pending, signal);
    } else if (!entry.pending && entry.retryAt !== undefined && this.timer.now() >= entry.retryAt) {
      // An incarnation's first read is the only one that may delay a tool call.
      entry.pending = this.fetch(key, entry, device);
    } else if (entry.pending && entry.retryAt === undefined) {
      // Join the initial read, with this caller's cancellation limited to its own wait.
      await awaitWhileRequestIsLive(entry.pending, signal);
    }
    return entry;
  }

  invalidate(deviceId: string): void {
    for (const key of this.entries.keys()) {
      if (key.endsWith(`:${deviceId}`)) {
        this.entries.delete(key);
      }
    }
  }

  private async fetch(key: string, entry: InventoryEntry, device: BootedDevice): Promise<void> {
    try {
      // Let hydrate store the pending promise before a source can throw synchronously.
      await Promise.resolve();
      const source = device.platform === "android" ? this.androidSource : this.iosSource;
      // The shared read has its own bounded source timeout, not a caller's signal.
      const result = await source.read(device);
      // Record even when invalidation replaced the entry: an orphaned entry is only seen by the
      // callers already awaiting it, which use it as their last-read fallback.
      this.recordRead(entry, result);
    } catch (error) {
      logger.warn(
        `[DisplayInventoryProvider] Inventory read failed for ${device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      entry.displays = null;
      entry.outcome = { kind: "unreadable", reason: errorMessage(error) };
      entry.retryAt = this.timer.now() + this.failureRetryMs;
    } finally {
      if (this.entries.get(key) === entry) {
        entry.pending = undefined;
      }
    }
  }

  private recordRead(
    entry: InventoryEntry,
    result: Awaited<ReturnType<DisplayInventorySource["read"]>>,
  ): void {
    if (result.displays || !result.degraded) {
      entry.displays = result.displays ?? null;
      entry.outcome = result.outcome ?? (result.displays ? { kind: "multi" } : { kind: "single" });
    } else if (!entry.outcome) {
      entry.outcome = result.outcome ?? {
        kind: "unreadable",
        reason: "display inventory command failed",
      };
    }
    entry.retryAt = result.degraded
      ? this.timer.now() + this.degradedRetryMs
      : result.outcome?.kind === "unreadable"
        ? this.timer.now() + this.failureRetryMs
        : undefined;
  }
}

export function createDisplayInventoryProvider(
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  simctl: Pick<SimCtlClient, "readDeviceDisplays"> = new SimCtlClient(null),
  timer: Pick<Timer, "now"> = defaultTimer,
): DisplayInventoryProvider {
  return new CachingDisplayInventoryProvider(
    {
      read: (device) => readAndroidDeviceDisplaysChecked(adbFactory.create(device)),
    },
    {
      read: async (device) => ({
        displays: await simctl.readDeviceDisplays(device.deviceId),
        degraded: false,
      }),
    },
    timer,
  );
}

export const defaultDisplayInventoryProvider = createDisplayInventoryProvider();

/** Read missing inventories only when a caller needs panel or posture matching. */
export async function hydrateRequiredDisplayInventories(
  devices: readonly BootedDevice[],
  requires: { panels?: number; posture?: string } | undefined,
  provider: DisplayInventoryProvider,
  signal?: AbortSignal,
): Promise<BootedDevice[]> {
  if (requires?.panels === undefined && requires?.posture === undefined) {
    return [...devices];
  }
  return Promise.all(
    devices.map(async (device) => {
      if (device.displays) {
        return device;
      }
      try {
        return await provider.hydrate(device, device.deviceId, signal);
      } catch (error) {
        logger.warn(
          `Display inventory for ${device.deviceId} could not be read: ${errorMessage(error)}`,
          error,
        );
        return {
          ...device,
          [displayInventoryOutcome]: { kind: "unreadable" as const, reason: errorMessage(error) },
        };
      }
    }),
  );
}
