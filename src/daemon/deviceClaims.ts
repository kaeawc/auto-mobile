import { errorMessage } from "../utils/describeUnknownError";
import type { LockOwnerGenerationVerdict } from "../utils/fileLock";
import { defaultLockOwnerGenerationProbe } from "../utils/lockOwnerGeneration";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import type { Platform } from "../models";

/** What holds the device (#11811): an allocation claim, a CtrlProxy forward, or a managed slot. */
export type DeviceClaimKind = "allocation" | "forward" | "slot";

export interface DeviceClaim {
  platform: Platform;
  deviceId: string;
  kind: DeviceClaimKind;
  daemonSessionId?: string;
  pid: number;
  /** The token the owning daemon recorded in its claim file; a release names it. */
  ownerToken: string;
  /** The owning process's generation token, so a reused PID is not mistaken for the owner. */
  processGenerationToken?: string;
  sessionUuid?: string;
  /** The owner's control-socket record, in the claim files' format, for liveness probes. */
  metadata?: string;
  claimedAtMs: number;
  updatedAtMs: number;
}

/** The host-wide `device_claims` table: it decides Android and iOS claims (#11811 step d). */
export interface DeviceClaims {
  /**
   * The claim-file winner is recorded, replacing any earlier row for the device. A row written
   * later (a larger `updatedAtMs`) is kept: a delayed write from a daemon that has since lost the
   * claim must not replace the winner's row.
   */
  upsert(claim: DeviceClaim): Promise<void>;
  /**
   * The atomic claim (#11811 step d): writes `claim` only while the device's row is still what the
   * caller judged it to be: no row when `expected` is undefined, else a row naming `expected`.
   * Returns false when the row changed meanwhile, so of two daemons racing for it one wins.
   */
  replaceIf(
    expected: { pid: number; ownerToken: string } | undefined,
    claim: DeviceClaim,
  ): Promise<boolean>;
  /** Removes the row only while `owner` still holds it; another owner's row is left alone. */
  release(
    platform: Platform,
    deviceId: string,
    owner: { pid: number; ownerToken: string },
  ): Promise<void>;
  /** Clean shutdown removes only rows naming both this PID and this owner's token. */
  releaseOwnedBy(owner: { pid: number; ownerToken: string }): Promise<void>;
  get(platform: Platform, deviceId: string): Promise<DeviceClaim | undefined>;
  list(): Promise<DeviceClaim[]>;
}

type MirrorOwner = { pid: number; ownerToken: string; metadata?: string };

/**
 * The ownership's view of the host-wide table. {@link acquire} lets the table decide a claim (#11811
 * step d); {@link claimed} and {@link released} record a claim the files decided (watch and TV have
 * no table, and a claim falls back to the files when no table can decide) and never block or fail it.
 */
export interface DeviceClaimMirror {
  /**
   * The table's row for `deviceId`, when one exists and its owner is not a reused PID. Undefined
   * when no registry is available, after briefly joining any existing open. Readers fall back
   * to the claim files when the table is unavailable or cannot be read.
   */
  read?(deviceId: string): Promise<DeviceClaim | undefined>;
  /**
   * `stillHeld` re-checks the claim file before any later write of this claim (a retry, a backfill):
   * a daemon whose claim another daemon took over is never told, and must not write it back.
   */
  claimed(
    deviceId: string,
    owner: { pid: number; ownerToken: string; metadata?: string },
    stillHeld?: () => boolean,
  ): void;
  released(deviceId: string, owner: { pid: number; ownerToken: string }): void;
  /**
   * The claim itself, decided by the table (#11811 step d): `claimed` once the row names this
   * owner, `refused` while a live foreign owner holds it, `unavailable` when no table can decide
   * (no registry, a skipped one, a failed write), and the claim files decide instead.
   */
  acquire?(
    deviceId: string,
    owner: MirrorOwner,
    isLiveForeignOwner: (row: DeviceClaim) => Promise<boolean>,
  ): Promise<DeviceClaimAcquisition>;
}

export type DeviceClaimAcquisition =
  | { outcome: "claimed" }
  | { outcome: "refused"; ownerPid: number }
  | { outcome: "unavailable" };

/** Racing takers retry the judge-then-write this many times before refusing. */
const ACQUIRE_ATTEMPTS = 3;

export interface StoreDeviceClaimMirrorOptions {
  platform: Platform;
  /** Resolved per write: the registry may open (or fail to open) after the mirror is attached. */
  store: () => DeviceClaims | undefined;
  /** Joins an open already started by startup or maintenance; never starts an open. */
  whenOpen?: () => Promise<DeviceClaims | undefined>;
  /** Probe only on deferred writes, using the existing bounded retry ladder. */
  registryFileExists?: () => boolean;
  /** True once registry opening is handled; false means ask again on the next write. */
  openRegistry?: () => boolean;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  daemonSessionId?: string;
  generationOf?: (pid: number) => string | undefined;
  /** Whether `recorded` still names `pid`'s process generation; a reused PID reads "different". */
  generationVerdict?: (pid: number, recorded: string) => LockOwnerGenerationVerdict;
  /** Delay before the nth retry of a device's write; its length bounds the retries. */
  retryDelaysMs?: readonly number[];
}

/** Delays before a failed or deferred write is retried: about eight minutes in all. */
export const DEVICE_CLAIM_MIRROR_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 5_000, 30_000, 120_000, 300_000,
];

export const DEVICE_CLAIM_READ_OPEN_TIMEOUT_MS = 2_000;

interface MirrorIntent {
  kind: "claim" | "release";
  /** Decided by the table, so it is written back only while no other owner has taken the row. */
  acquired?: true;
  owner: MirrorOwner;
  claimedAtMs: number;
  stillHeld?: () => boolean;
  /** Changes with every new intent, so a write that finished for an older one is not final. */
  version: number;
  /** The table holds what this intent says. */
  synced: boolean;
  attempts: number;
  retry?: NodeJS.Timeout;
}

/**
 * Mirrors this daemon's claims into the table without ever deciding one. It keeps what each device
 * should read (claimed by this owner, or released), writes it when a registry is open and again
 * when one opens later ({@link reconcile}), and retries a failed or deferred write on a bounded
 * backoff. {@link idle} joins the writes in flight.
 */
export class StoreDeviceClaimMirror implements DeviceClaimMirror {
  private readonly intents = new Map<string, MirrorIntent>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly generationOf: (pid: number) => string | undefined;
  private readonly retryDelays: readonly number[];
  private versions = 0;
  private disposed = false;
  private skipped = false;
  private registryOpeningHandled = false;

  constructor(private readonly options: StoreDeviceClaimMirrorOptions) {
    this.generationOf =
      options.generationOf ?? ((pid) => defaultLockOwnerGenerationProbe.current(pid));
    this.retryDelays = options.retryDelaysMs ?? DEVICE_CLAIM_MIRROR_RETRY_DELAYS_MS;
  }

  /** Unknown registry migrations disable the mirror for this daemon's lifetime; restart re-evaluates. */
  skip(): void {
    this.skipped = true;
    for (const intent of this.intents.values()) {
      this.clearRetry(intent);
    }
    this.intents.clear();
  }

  claimed(deviceId: string, owner: MirrorOwner, stillHeld?: () => boolean): void {
    if (this.skipped) {
      return;
    }
    const held = this.intents.get(deviceId);
    const sameOwner =
      held?.kind === "claim" &&
      held.owner.pid === owner.pid &&
      held.owner.ownerToken === owner.ownerToken;
    this.record(deviceId, {
      kind: "claim",
      owner,
      claimedAtMs: sameOwner ? held.claimedAtMs : this.options.timer.now(),
      ...(stillHeld === undefined ? {} : { stillHeld }),
    });
  }

  released(deviceId: string, owner: MirrorOwner): void {
    if (this.skipped) {
      return;
    }
    this.record(deviceId, { kind: "release", owner, claimedAtMs: this.options.timer.now() });
  }

  async acquire(
    deviceId: string,
    owner: MirrorOwner,
    isLiveForeignOwner: (row: DeviceClaim) => Promise<boolean>,
  ): Promise<DeviceClaimAcquisition> {
    const store = this.skipped ? undefined : await this.readStore();
    if (!store || this.skipped || this.disposed) {
      return { outcome: "unavailable" };
    }
    try {
      for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
        const decided = await this.acquireOnce(store, deviceId, owner, isLiveForeignOwner);
        if (decided) {
          return decided;
        }
      }
      const winner = await store.get(this.options.platform, deviceId);
      return winner ? { outcome: "refused", ownerPid: winner.pid } : { outcome: "unavailable" };
    } catch (error) {
      logger.warn(
        `[DeviceClaims] Cannot claim ${deviceId} in the host-wide table; the claim files decide: ${errorMessage(error)}`,
        error,
      );
      return { outcome: "unavailable" };
    }
  }

  /** One judge-then-write; undefined when the row changed meanwhile and the caller should retry. */
  private async acquireOnce(
    store: DeviceClaims,
    deviceId: string,
    owner: MirrorOwner,
    isLiveForeignOwner: (row: DeviceClaim) => Promise<boolean>,
  ): Promise<DeviceClaimAcquisition | undefined> {
    const row = await store.get(this.options.platform, deviceId);
    const ours = row?.pid === owner.pid && row.ownerToken === owner.ownerToken;
    if (row && !ours && (await this.isLiveOwner(row, isLiveForeignOwner))) {
      return { outcome: "refused", ownerPid: row.pid };
    }
    const claimedAtMs = ours ? row.claimedAtMs : this.options.timer.now();
    if (!(await store.replaceIf(row, this.claimRow(deviceId, owner, claimedAtMs)))) {
      return undefined;
    }
    this.recordAcquired(deviceId, owner, claimedAtMs);
    return { outcome: "claimed" };
  }

  /** A row whose process generation was reused is dead whatever its PID says. */
  private async isLiveOwner(
    row: DeviceClaim,
    isLiveForeignOwner: (row: DeviceClaim) => Promise<boolean>,
  ): Promise<boolean> {
    if (row.processGenerationToken !== undefined && this.generationVerdict(row) === "different") {
      return false;
    }
    return isLiveForeignOwner(row);
  }

  private generationVerdict(row: DeviceClaim): LockOwnerGenerationVerdict {
    return (
      this.options.generationVerdict?.(row.pid, row.processGenerationToken!) ??
      defaultLockOwnerGenerationProbe.compare(row.pid, row.processGenerationToken!)
    );
  }

  /** Track an acquired claim like a mirrored one, so release and registry reopening see it. */
  private recordAcquired(deviceId: string, owner: MirrorOwner, claimedAtMs: number): void {
    const previous = this.intents.get(deviceId);
    if (previous) {
      this.clearRetry(previous);
    }
    this.intents.set(deviceId, {
      kind: "claim",
      acquired: true,
      owner,
      claimedAtMs,
      version: ++this.versions,
      synced: true,
      attempts: 0,
    });
  }

  async read(deviceId: string): Promise<DeviceClaim | undefined> {
    if (this.skipped) {
      return undefined;
    }
    const store = await this.readStore();
    if (this.skipped) {
      return undefined;
    }
    const row = await store?.get(this.options.platform, deviceId);
    if (this.skipped || !row) {
      return undefined;
    }
    if (row.processGenerationToken !== undefined && this.generationVerdict(row) === "different") {
      return undefined;
    }
    return row;
  }

  /** Join a pending open without letting a terminal skip surface its already-reported failure. */
  private async readStore(): Promise<DeviceClaims | undefined> {
    let store: DeviceClaims | undefined;
    try {
      store =
        this.options.store() ??
        (this.options.whenOpen
          ? await raceWithDeadline(this.options.whenOpen, {
              timer: this.options.timer,
              timeoutMs: DEVICE_CLAIM_READ_OPEN_TIMEOUT_MS,
              label: "Device claim registry open",
            })
          : undefined);
    } catch (error) {
      if (!this.skipped) {
        throw error;
      }
      // The hub skipped while this read joined an open; claim files decide after its failure.
      logger.debug(`[DeviceClaims] Ignoring skipped registry open: ${errorMessage(error)}`);
      return undefined;
    }
    return store;
  }

  /**
   * A registry opened (or reopened): write every claim this daemon holds and every release still
   * owed, whatever was written before. Restarts the retry budget of each.
   */
  reconcile(store?: DeviceClaims): void {
    if (this.skipped) {
      return;
    }
    for (const [deviceId, intent] of this.intents) {
      intent.synced = false;
      intent.attempts = 0;
      // A write in flight may have gone to the registry that closed: it is not this one's.
      intent.version = ++this.versions;
      this.clearRetry(intent);
      this.write(deviceId, store);
    }
  }

  /** Stop writing and retrying; the claims leave the table with the registry on shutdown. */
  dispose(): void {
    this.disposed = true;
    for (const intent of this.intents.values()) {
      this.clearRetry(intent);
    }
  }

  /** Resolves once every write in flight has settled. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()]);
    }
  }

  /** After disposal and draining, withdraw only the owner generations this mirror recorded. */
  async releaseOwnedClaims(store: DeviceClaims): Promise<void> {
    if (this.skipped) {
      return;
    }
    const owners = new Map<string, MirrorOwner>();
    for (const intent of this.intents.values()) {
      owners.set(`${intent.owner.pid}:${intent.owner.ownerToken}`, intent.owner);
    }
    for (const owner of owners.values()) {
      if (this.skipped) {
        return;
      }
      await store.releaseOwnedBy(owner);
    }
  }

  private record(
    deviceId: string,
    intent: Pick<MirrorIntent, "kind" | "owner" | "claimedAtMs" | "stillHeld">,
  ) {
    if (this.disposed || this.skipped) {
      return;
    }
    const previous = this.intents.get(deviceId);
    if (previous) {
      this.clearRetry(previous);
    }
    this.intents.set(deviceId, {
      ...intent,
      version: ++this.versions,
      synced: false,
      attempts: 0,
    });
    this.write(deviceId);
  }

  private write(deviceId: string, given?: DeviceClaims): void {
    const intent = this.intents.get(deviceId);
    if (!intent || this.disposed || this.skipped || this.inFlight.has(deviceId)) {
      // An in-flight write looks again when it settles, so a newer intent is never dropped.
      return;
    }
    if (intent.kind === "claim" && this.isGone(intent)) {
      // The claim file moved on without telling us: the table is that owner's to write.
      this.clearRetry(intent);
      this.intents.delete(deviceId);
      return;
    }
    const store = given ?? this.options.store();
    if (!store) {
      // The registry is not open (yet): the files decide meanwhile, and a retry or the registry's
      // opening writes this.
      this.probeRegistry();
      this.scheduleRetry(deviceId, intent);
      return;
    }
    const issued = intent.version;
    const settled = this.issue(store, deviceId, intent)
      .then(
        () => {
          if (this.intents.get(deviceId)?.version === issued) {
            this.confirm(deviceId, intent);
          }
        },
        (error: unknown) => {
          logger.warn(
            `[DeviceClaims] Cannot ${intent.kind === "claim" ? "record" : "remove"} the claim on ` +
              `${deviceId} in the host-wide table: ${errorMessage(error)}`,
            error,
          );
          if (this.intents.get(deviceId)?.version === issued) {
            this.scheduleRetry(deviceId, intent);
          }
        },
      )
      .finally(() => {
        this.inFlight.delete(deviceId);
        const latest = this.intents.get(deviceId);
        if (latest && latest.version !== issued) {
          this.write(deviceId);
        }
      });
    this.inFlight.set(deviceId, settled);
  }

  private probeRegistry(): void {
    if (this.registryOpeningHandled || !this.options.openRegistry) {
      return;
    }
    try {
      if (this.options.registryFileExists?.()) {
        this.registryOpeningHandled = this.options.openRegistry();
      }
    } catch (error) {
      logger.warn(`[DeviceClaims] Cannot start registry opening: ${errorMessage(error)}`, error);
    }
  }

  private isGone(intent: MirrorIntent): boolean {
    try {
      return intent.stillHeld?.() === false;
    } catch (error) {
      // An unreadable claim file proves nothing: keep the intent and write it.
      logger.debug(`[DeviceClaims] Cannot re-check a claim file: ${errorMessage(error)}`);
      return false;
    }
  }

  private async issue(store: DeviceClaims, deviceId: string, intent: MirrorIntent): Promise<void> {
    if (intent.kind === "release") {
      return store.release(this.options.platform, deviceId, intent.owner);
    }
    const row = this.claimRow(deviceId, intent.owner, intent.claimedAtMs);
    if (!intent.acquired) {
      return store.upsert(row);
    }
    // A table-decided claim is written back only where the row is still ours or gone: another
    // owner that took the device meanwhile keeps it, and this intent is dropped.
    const held = await store.get(this.options.platform, deviceId);
    const ours = held?.pid === intent.owner.pid && held.ownerToken === intent.owner.ownerToken;
    if ((held && !ours) || !(await store.replaceIf(held, row))) {
      if (this.intents.get(deviceId) === intent) {
        this.intents.delete(deviceId);
      }
    }
  }

  private claimRow(deviceId: string, owner: MirrorOwner, claimedAtMs: number): DeviceClaim {
    const processGenerationToken = this.generationOf(owner.pid);
    return {
      platform: this.options.platform,
      deviceId,
      kind: "allocation",
      ...(this.options.daemonSessionId === undefined
        ? {}
        : { daemonSessionId: this.options.daemonSessionId }),
      pid: owner.pid,
      ownerToken: owner.ownerToken,
      ...(processGenerationToken === undefined ? {} : { processGenerationToken }),
      ...(owner.metadata === undefined ? {} : { metadata: owner.metadata }),
      claimedAtMs,
      updatedAtMs: this.options.timer.now(),
    };
  }

  private confirm(deviceId: string, intent: MirrorIntent): void {
    if (intent.kind === "release") {
      // Nothing is held, and nothing is owed any more.
      this.intents.delete(deviceId);
      return;
    }
    intent.synced = true;
    intent.attempts = 0;
  }

  private scheduleRetry(deviceId: string, intent: MirrorIntent): void {
    if (this.disposed || this.skipped || intent.retry !== undefined) {
      return;
    }
    const delay = this.retryDelays[intent.attempts];
    if (delay === undefined) {
      // Out of retries: the next claim, release or registry opening writes it again.
      return;
    }
    intent.attempts++;
    intent.retry = this.options.timer.setTimeout(() => {
      intent.retry = undefined;
      if (this.intents.get(deviceId) === intent && !intent.synced) {
        this.write(deviceId);
      }
    }, delay);
  }

  private clearRetry(intent: MirrorIntent): void {
    if (intent.retry !== undefined) {
      this.options.timer.clearTimeout(intent.retry);
      intent.retry = undefined;
    }
  }
}

/**
 * The claims table of whichever binding registry this daemon has open, once that open settled.
 * Never opens one: a daemon without a registry keeps the files alone.
 */
export function lazyDeviceClaims(
  registry: () => Promise<{ deviceClaims(): DeviceClaims }> | undefined,
): () => DeviceClaims | undefined {
  let watching: Promise<unknown> | undefined;
  let current: DeviceClaims | undefined;
  return () => {
    const opening = registry();
    if (opening !== watching) {
      watching = opening;
      current = undefined;
      opening?.then(
        (opened) => {
          if (watching === opening) {
            current = opened.deviceClaims();
          }
        },
        // The open's failure is logged where the open is awaited; the mirror just stays idle.
        () => undefined,
      );
    }
    return current;
  };
}
