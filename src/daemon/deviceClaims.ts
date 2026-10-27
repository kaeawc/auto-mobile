import { errorMessage } from "../utils/describeUnknownError";
import type { LockOwnerGenerationVerdict } from "../utils/fileLock";
import { defaultLockOwnerGenerationProbe } from "../utils/lockOwnerGeneration";
import { logger } from "../utils/logger";
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

/** The host-wide `device_claims` table. Step (b) only writes it beside the claim files. */
export interface DeviceClaims {
  /**
   * The claim-file winner is recorded, replacing any earlier row for the device. A row written
   * later (a larger `updatedAtMs`) is kept: a delayed write from a daemon that has since lost the
   * claim must not replace the winner's row.
   */
  upsert(claim: DeviceClaim): Promise<void>;
  /** Removes the row only while `owner` still holds it; another owner's row is left alone. */
  release(
    platform: Platform,
    deviceId: string,
    owner: { pid: number; ownerToken: string },
  ): Promise<void>;
  /** Removes every row this process owns (a clean shutdown); other owners' rows are left alone. */
  releaseOwnedBy(pid: number): Promise<void>;
  get(platform: Platform, deviceId: string): Promise<DeviceClaim | undefined>;
  list(): Promise<DeviceClaim[]>;
}

/**
 * What the file-based ownership reports to the table once it has won or given up a claim. Calls
 * never block or fail the claim: the files stay authoritative until a later step (#11811 c).
 */
export interface DeviceClaimMirror {
  /**
   * The table's row for `deviceId`, when one exists and its owner is not a reused PID. Undefined
   * when no registry is open: readers then fall back to the claim files.
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
}

export interface StoreDeviceClaimMirrorOptions {
  platform: Platform;
  /** Resolved per write: the registry may open (or fail to open) after the mirror is attached. */
  store: () => DeviceClaims | undefined;
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

type MirrorOwner = { pid: number; ownerToken: string; metadata?: string };

interface MirrorIntent {
  kind: "claim" | "release";
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

  constructor(private readonly options: StoreDeviceClaimMirrorOptions) {
    this.generationOf =
      options.generationOf ?? ((pid) => defaultLockOwnerGenerationProbe.current(pid));
    this.retryDelays = options.retryDelaysMs ?? DEVICE_CLAIM_MIRROR_RETRY_DELAYS_MS;
  }

  claimed(deviceId: string, owner: MirrorOwner, stillHeld?: () => boolean): void {
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
    this.record(deviceId, { kind: "release", owner, claimedAtMs: this.options.timer.now() });
  }

  async read(deviceId: string): Promise<DeviceClaim | undefined> {
    const row = await this.options.store()?.get(this.options.platform, deviceId);
    if (!row) {
      return undefined;
    }
    if (row.processGenerationToken !== undefined) {
      const verdict =
        this.options.generationVerdict?.(row.pid, row.processGenerationToken) ??
        defaultLockOwnerGenerationProbe.compare(row.pid, row.processGenerationToken);
      if (verdict === "different") {
        return undefined;
      }
    }
    return row;
  }

  /**
   * A registry opened (or reopened): write every claim this daemon holds and every release still
   * owed, whatever was written before. Restarts the retry budget of each.
   */
  reconcile(store?: DeviceClaims): void {
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

  private record(
    deviceId: string,
    intent: Pick<MirrorIntent, "kind" | "owner" | "claimedAtMs" | "stillHeld">,
  ) {
    if (this.disposed) {
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
    if (!intent || this.disposed || this.inFlight.has(deviceId)) {
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

  private isGone(intent: MirrorIntent): boolean {
    try {
      return intent.stillHeld?.() === false;
    } catch (error) {
      // An unreadable claim file proves nothing: keep the intent and write it.
      logger.debug(`[DeviceClaims] Cannot re-check a claim file: ${errorMessage(error)}`);
      return false;
    }
  }

  private issue(store: DeviceClaims, deviceId: string, intent: MirrorIntent): Promise<void> {
    if (intent.kind === "release") {
      return store.release(this.options.platform, deviceId, intent.owner);
    }
    const nowMs = this.options.timer.now();
    const processGenerationToken = this.generationOf(intent.owner.pid);
    return store.upsert({
      platform: this.options.platform,
      deviceId,
      kind: "allocation",
      ...(this.options.daemonSessionId === undefined
        ? {}
        : { daemonSessionId: this.options.daemonSessionId }),
      pid: intent.owner.pid,
      ownerToken: intent.owner.ownerToken,
      ...(processGenerationToken === undefined ? {} : { processGenerationToken }),
      ...(intent.owner.metadata === undefined ? {} : { metadata: intent.owner.metadata }),
      claimedAtMs: intent.claimedAtMs,
      updatedAtMs: nowMs,
    });
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
    if (this.disposed || intent.retry !== undefined) {
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
