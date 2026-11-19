import type { BootedDevice } from "../models";
import { displayInventoryOutcome, type DisplayInventoryOutcome } from "../models/DeviceInfo";
import type { DeviceDisplays, DisplayPanel } from "../models/DisplayPanel";
import type { AdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { readAndroidDeviceDisplaysChecked } from "../utils/android-cmdline-tools/AndroidDisplayInventory";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import { SIMULATOR_DISPLAY_ENUMERATE_TIMEOUT_MS } from "../utils/ios-cmdline-tools/SimCtlInventory";
import {
  exponentialBackoff,
  normalizeBackoff,
  type BackoffInput,
  type BackoffPolicy,
} from "../utils/Backoff";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { awaitWhileRequestIsLive } from "../utils/toolUtils";
import { runWithDeviceExecutionBinding } from "../utils/deviceExecutionBinding";

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

/** Last successful panel list and consecutive failed reads for one device incarnation. */
interface InventoryHistory {
  token: string;
  lastGood?: { displays: DeviceDisplays; outcome: DisplayInventoryOutcome };
  failures: number;
}

/**
 * Failed reads retry after 2 s, doubling to the old 30 s ceiling: a timed-out enumerate on a
 * loaded host usually succeeds on the next attempt, so a single failure must not park it for 30 s.
 */
const DEFAULT_FAILURE_BACKOFF = exponentialBackoff({ initialDelayMs: 2_000, maxDelayMs: 30_000 });

/** Extra reads a hydrate may start when a display event invalidates the inventory mid-read. */
const MAX_INVENTORY_REREADS = 2;

function hasReadInventory(entry: InventoryEntry): boolean {
  return entry.outcome !== undefined && entry.outcome.kind !== "unreadable";
}

export class CachingDisplayInventoryProvider implements DisplayInventoryProvider {
  private readonly entries = new Map<string, InventoryEntry>();
  /** Survives invalidate(): a booted device's panel set is fixed, only its posture changes. */
  private readonly history = new Map<string, InventoryHistory>();

  private readonly timer: Pick<Timer, "now">;
  private readonly degradedRetryMs: number;
  private readonly failureBackoff: BackoffPolicy;

  constructor(
    private readonly androidSource: DisplayInventorySource,
    private readonly iosSource: DisplayInventorySource,
    {
      timer = defaultTimer,
      degradedRetryMs = 5_000,
      failureBackoff = DEFAULT_FAILURE_BACKOFF,
    }: {
      timer?: Pick<Timer, "now">;
      degradedRetryMs?: number;
      /** Delay before re-reading after the Nth consecutive failed or unreadable read. */
      failureBackoff?: BackoffInput;
    } = {},
  ) {
    this.timer = timer;
    this.degradedRetryMs = degradedRetryMs;
    this.failureBackoff = normalizeBackoff(failureBackoff);
  }

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

  /** Settled Android inventory only; never starts or waits for a read. */
  cachedPanels(deviceId: string): readonly DisplayPanel[] | undefined {
    const entry = this.entries.get(`android:${deviceId}`);
    return entry && !entry.pending ? entry.displays?.panels : undefined;
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
      // Shared inventory reads may outlive their caller and must not bind its execution.
      const result = await runWithDeviceExecutionBinding(undefined, () => source.read(device));
      // Record even when invalidation replaced the entry: an orphaned entry is only seen by the
      // callers already awaiting it, which use it as their last-read fallback.
      this.recordRead(key, entry, result);
    } catch (error) {
      logger.warn(
        `[DisplayInventoryProvider] Inventory read failed for ${device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      entry.displays = null;
      entry.outcome = { kind: "unreadable", reason: errorMessage(error) };
      this.recordFailure(key, entry);
    } finally {
      if (this.entries.get(key) === entry) {
        entry.pending = undefined;
      }
    }
  }

  private recordRead(
    key: string,
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
    if (entry.outcome.kind === "unreadable") {
      this.recordFailure(key, entry);
      return;
    }
    const history = this.historyFor(key, entry.token);
    history.failures = 0;
    history.lastGood = entry.displays
      ? { displays: entry.displays, outcome: entry.outcome }
      : undefined;
    entry.retryAt = result.degraded ? this.timer.now() + this.degradedRetryMs : undefined;
  }

  /**
   * An unreadable read keeps the incarnation's last good panels (a simulator's panel set is fixed
   * while booted) and retries on the failure backoff, so a timed-out read after a posture change
   * does not drop observe to the single-display default.
   */
  private recordFailure(key: string, entry: InventoryEntry): void {
    const history = this.historyFor(key, entry.token);
    history.failures++;
    if (history.lastGood) {
      logger.warn(
        `[DisplayInventoryProvider] Serving last good display inventory for ${key} after a failed read`,
      );
      entry.displays = history.lastGood.displays;
      entry.outcome = history.lastGood.outcome;
    }
    entry.retryAt = this.timer.now() + this.failureBackoff.delayForAttempt(history.failures);
  }

  private historyFor(key: string, token: string): InventoryHistory {
    let history = this.history.get(key);
    if (!history || history.token !== token) {
      history = { token, failures: 0 };
      this.history.set(key, history);
    }
    return history;
  }
}

export function createDisplayInventoryProvider(
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
  simctl: Pick<SimCtlClient, "readDeviceDisplays"> = new SimCtlClient(null),
  timer: Pick<Timer, "now"> = defaultTimer,
  {
    iosEnumerateTimeoutMs = SIMULATOR_DISPLAY_ENUMERATE_TIMEOUT_MS,
  }: { iosEnumerateTimeoutMs?: number } = {},
): CachingDisplayInventoryProvider {
  return new CachingDisplayInventoryProvider(
    {
      read: (device) => readAndroidDeviceDisplaysChecked(adbFactory.create(device)),
    },
    {
      read: async (device) => ({
        displays: await simctl.readDeviceDisplays(
          device.deviceId,
          undefined,
          iosEnumerateTimeoutMs,
        ),
        degraded: false,
      }),
    },
    { timer },
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
