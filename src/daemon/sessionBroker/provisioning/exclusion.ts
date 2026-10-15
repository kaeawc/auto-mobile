import { BindingRegistryUpgradePendingError } from "../registry/bindingRegistryMigrations";
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { Timer } from "../../../utils/SystemTimer";
import { DeviceAssignedToBindingError, BindingDiscoveryIncompleteError } from "./refusal";
import type {
  ManagedDeviceEntry,
  BindingKey,
  BindingPlatform,
  BindingRegistry,
} from "../registry/bindingRegistry";
import {
  openSqliteBindingRegistry,
  bindingRegistryFileExists,
} from "../registry/sqliteBindingRegistry";

/**
 * A device as generic allocation sees it: its platform and every stable identity it is known by
 * (AVD name, simulator UDID, or a physical serial). Unknown identities are left out.
 */
export interface ManagedDeviceRef {
  platform: BindingPlatform;
  stableIds: ReadonlyArray<string | undefined>;
}

export interface BindingRefreshOptions {
  /** Reuse a snapshot younger than this. 0 (the default) always re-reads the registry. */
  maxAgeMs?: number;
  /** Refuse a failed read even when the last good snapshot is retained. */
  requireCurrent?: boolean;
  /**
   * Run a load that starts after this call, never joining one already in flight (which may have
   * read the registry before the caller's own change). Concurrent fresh calls share one load.
   */
  fresh?: boolean;
}

/**
 * Generic-pool exclusion for bindings (#11174 part b, #11178 part a): every device a managed
 * binding holds, idle or not, plus the managed free pool, read from the host-wide {@link BindingRegistry}.
 *
 * Lookups are synchronous against the last snapshot so the pool's hot path stays synchronous;
 * callers refresh first. An unreadable registry keeps the last good snapshot; when none was ever
 * loaded, or requireCurrent is requested, refresh throws {@link BindingDiscoveryIncompleteError} instead of reporting "free".
 * On that failed read, DevicePool admits a session already holding its device before consulting
 * retained entries; retained refusals for other sessions are retryable discovery failures. Plain
 * callers keep known-device refusals, and reconciler exemptions remain binding-specific.
 */
export interface BindingExclusion {
  refresh(options?: BindingRefreshOptions): Promise<void>;
  /** True after a failed registry read; cleared by a successful or absent load. */
  lastReadFailed?(): boolean;
  /** The managed entry holding the device, from the last snapshot. */
  holderOf(device: ManagedDeviceRef): ManagedDeviceEntry | undefined;
  /** Every stable id the last snapshot holds for `platform`, for selector-based boots. */
  stableIdsFor(platform: BindingPlatform): ReadonlySet<string>;
}

/**
 * The binding whose reconciler is running in the current async context (#11173). Set only by the
 * daemon's binding acquisition, never from tool arguments, so no MCP caller can enter it.
 */
const reconcilingBinding = new AsyncLocalStorage<BindingKey>();

/**
 * Run the reconciler of one binding. Inside it, the generic-exclusion guard lets the provision and
 * delete paths act on THAT binding's device (and on the managed free pool, which only bindings
 * may adopt): the reconciler holds no execution session yet, so the session check alone would
 * refuse it. Every other binding's device stays refused.
 */
export function runAsBindingReconciler<T>(
  key: BindingKey,
  operation: () => Promise<T>,
): Promise<T> {
  return reconcilingBinding.run(
    { scopeKey: key.scopeKey, bindingIndex: key.bindingIndex },
    operation,
  );
}

/** The binding being reconciled in this async context, if any. */
export function currentBindingReconciler(): BindingKey | undefined {
  return reconcilingBinding.getStore();
}

function reconcilerMayAct(entry: ManagedDeviceEntry): boolean {
  const binding = reconcilingBinding.getStore();
  if (!binding) {
    return false;
  }
  return entry.scopeKey === binding.scopeKey && entry.bindingIndex === binding.bindingIndex;
}

/**
 * The refusal for a caller that is not the binding's own live execution, or undefined when it may
 * proceed. Only the session recorded as the binding's execution owner may control its device; no
 * force flag or idle state overrides that.
 */
export function bindingRefusal(
  exclusion: BindingExclusion | undefined,
  input: {
    action: string;
    deviceId: string;
    device: ManagedDeviceRef;
    /** The caller's (base) session, when it has one. */
    requesterSessionUuid?: string;
  },
): DeviceAssignedToBindingError | undefined {
  const entry = exclusion?.holderOf(input.device);
  if (!entry) {
    return undefined;
  }
  if (
    entry.holder === "session_broker" &&
    entry.execSessionUuid !== null &&
    input.requesterSessionUuid === entry.execSessionUuid
  ) {
    return undefined;
  }
  if (reconcilerMayAct(entry)) {
    return undefined;
  }
  return new DeviceAssignedToBindingError(input.action, input.deviceId, entry);
}

function entryKey(platform: BindingPlatform, stableId: string): string {
  return JSON.stringify([platform, stableId]);
}

interface LoadedSnapshot {
  kind: "loaded";
  byDevice: Map<string, ManagedDeviceEntry>;
  byPlatform: Map<BindingPlatform, Set<string>>;
  loadedAtMs: number;
}

/** No host registry exists: nothing is managed. Not a read of the registry, so never a "last good" snapshot. */
interface AbsentSnapshot {
  kind: "absent";
  loadedAtMs: number;
}

/** The registry exists (or was opened) but has not been read successfully yet: unknown, never free. */
interface UnreadableSnapshot {
  kind: "unreadable";
}

type RegistryState = LoadedSnapshot | AbsentSnapshot | UnreadableSnapshot;

export class RegistryBindingExclusion implements BindingExclusion {
  private snapshot: RegistryState | undefined;
  private readFailed = false;
  private inFlight: Promise<void> | undefined;
  private registry: Promise<BindingRegistry> | undefined;
  private warnedUpgradePending = false;

  constructor(
    private readonly openRegistry: () => Promise<BindingRegistry>,
    private readonly timer: Pick<Timer, "now">,
    /**
     * Whether the registry exists yet. While it does not, nothing is managed: the snapshot is empty
     * and the registry is not opened (opening would create it). Defaults to always existing.
     */
    private readonly registryExists: () => boolean = () => true,
  ) {}

  async refresh(options: BindingRefreshOptions = {}): Promise<void> {
    if (!options.fresh && this.snapshotIsYoung(options.maxAgeMs ?? 0)) {
      return;
    }
    try {
      await (options.fresh ? this.refreshFresh() : this.loadShared());
    } catch (error) {
      if (
        options.requireCurrent ||
        this.snapshot?.kind !== "loaded" ||
        !(error instanceof BindingDiscoveryIncompleteError)
      ) {
        throw error;
      }
      // Inventory and streams may keep using the retained snapshot after an unreadable registry.
      logger.debug(`[Bindings] Using retained exclusion snapshot: ${errorMessage(error)}`);
    }
  }

  private snapshotIsYoung(maxAgeMs: number): boolean {
    return (
      maxAgeMs > 0 &&
      this.snapshot !== undefined &&
      this.snapshot.kind !== "unreadable" &&
      this.timer.now() - this.snapshot.loadedAtMs < maxAgeMs
    );
  }

  private loadShared(): Promise<void> {
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private freshWaiter: Promise<void> | undefined;

  private refreshFresh(): Promise<void> {
    // Queued fresh callers share a load that has not started; later calls queue a new load.
    if (this.freshWaiter) {
      return this.freshWaiter;
    }
    const older = this.inFlight;
    if (!older) {
      return this.loadShared();
    }
    const next = () => {
      this.freshWaiter = undefined;
      return this.loadShared();
    };
    // The older load's outcome belongs to its callers; this call always reads again.
    const waiter = older.then(next, next);
    this.freshWaiter = waiter;
    return waiter;
  }

  lastReadFailed(): boolean {
    return this.readFailed;
  }

  holderOf(device: ManagedDeviceRef): ManagedDeviceEntry | undefined {
    if (this.snapshot?.kind !== "loaded") {
      return undefined;
    }
    const byDevice = this.snapshot.byDevice;
    for (const stableId of device.stableIds) {
      const entry = stableId ? byDevice.get(entryKey(device.platform, stableId)) : undefined;
      if (entry) {
        return entry;
      }
    }
    return undefined;
  }

  stableIdsFor(platform: BindingPlatform): ReadonlySet<string> {
    return this.snapshot?.kind === "loaded"
      ? (this.snapshot.byPlatform.get(platform) ?? new Set())
      : new Set();
  }

  private async load(): Promise<void> {
    let entries: ManagedDeviceEntry[];
    if (this.registry === undefined && !this.registryExists()) {
      // A host that never served a managed binding has no registry: nothing is managed, and reading
      // must not create the file. This is "absent", not a successful read of the registry.
      this.snapshot = { kind: "absent", loadedAtMs: this.timer.now() };
      this.readFailed = false;
      return;
    }
    try {
      entries = await (await this.openRegistryOnce()).snapshotManagedDevices();
    } catch (error) {
      if (error instanceof BindingRegistryUpgradePendingError) {
        if (!this.warnedUpgradePending) {
          logger.warn(
            "[Bindings] Registry upgrade pending; treating exclusion as absent until retirement completes",
            error,
          );
          this.warnedUpgradePending = true;
        }
        this.snapshot = { kind: "absent", loadedAtMs: this.timer.now() };
        this.readFailed = false;
        return;
      }
      this.readFailed = true;
      if (this.snapshot?.kind === "loaded") {
        logger.warn(
          `[Bindings] Registry unreadable; keeping the last snapshot: ${errorMessage(error)}`,
          error,
        );
      } else {
        // Never read successfully: unknown is never free, even if an earlier refresh saw it absent.
        this.snapshot = { kind: "unreadable" };
      }
      throw new BindingDiscoveryIncompleteError(errorMessage(error));
    }
    const byDevice = new Map<string, ManagedDeviceEntry>();
    const byPlatform = new Map<BindingPlatform, Set<string>>();
    for (const entry of entries) {
      byDevice.set(entryKey(entry.platform, entry.stableDeviceId), entry);
      const ids = byPlatform.get(entry.platform) ?? new Set<string>();
      ids.add(entry.stableDeviceId);
      byPlatform.set(entry.platform, ids);
    }
    this.snapshot = { kind: "loaded", byDevice, byPlatform, loadedAtMs: this.timer.now() };
    this.readFailed = false;
  }

  private openRegistryOnce(): Promise<BindingRegistry> {
    this.registry ??= this.openRegistry().catch((error: unknown) => {
      // Let the next refresh retry the open instead of caching the failure.
      this.registry = undefined;
      throw error;
    });
    return this.registry;
  }
}

let sharedHostRegistry: Promise<BindingRegistry> | undefined;

/**
 * The daemon's default: the host-wide SQLite registry, opened lazily on first use and shared by
 * every pool in this process. A failed open is retried on the next refresh.
 */
export function createDefaultBindingExclusion(timer: Pick<Timer, "now">): BindingExclusion {
  return new RegistryBindingExclusion(
    () => {
      sharedHostRegistry ??= openSqliteBindingRegistry({ migrate: false }).catch(
        (error: unknown) => {
          sharedHostRegistry = undefined;
          throw error;
        },
      );
      return sharedHostRegistry;
    },
    timer,
    () => sharedHostRegistry !== undefined || bindingRegistryFileExists(),
  );
}
