import { errorMessage } from "../utils/describeUnknownError";
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
  claimed(deviceId: string, owner: { pid: number; ownerToken: string }): void;
  released(deviceId: string, owner: { pid: number; ownerToken: string }): void;
}

export interface StoreDeviceClaimMirrorOptions {
  platform: Platform;
  /** Resolved per write: the registry may open (or fail to open) after the mirror is attached. */
  store: () => DeviceClaims | undefined;
  timer: Pick<Timer, "now">;
  daemonSessionId?: string;
  generationOf?: (pid: number) => string | undefined;
}

/** Fire-and-forget writes with a trace on failure; {@link idle} joins the ones in flight. */
export class StoreDeviceClaimMirror implements DeviceClaimMirror {
  private readonly pending = new Set<Promise<void>>();
  private readonly generationOf: (pid: number) => string | undefined;

  constructor(private readonly options: StoreDeviceClaimMirrorOptions) {
    this.generationOf =
      options.generationOf ?? ((pid) => defaultLockOwnerGenerationProbe.current(pid));
  }

  claimed(deviceId: string, owner: { pid: number; ownerToken: string }): void {
    this.run(`record the claim on ${deviceId}`, async (store) => {
      const nowMs = this.options.timer.now();
      const processGenerationToken = this.generationOf(owner.pid);
      await store.upsert({
        platform: this.options.platform,
        deviceId,
        kind: "allocation",
        ...(this.options.daemonSessionId === undefined
          ? {}
          : { daemonSessionId: this.options.daemonSessionId }),
        pid: owner.pid,
        ownerToken: owner.ownerToken,
        ...(processGenerationToken === undefined ? {} : { processGenerationToken }),
        claimedAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    });
  }

  released(deviceId: string, owner: { pid: number; ownerToken: string }): void {
    this.run(`remove the claim on ${deviceId}`, (store) =>
      store.release(this.options.platform, deviceId, owner),
    );
  }

  /** Resolves once every write issued so far has settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  private run(what: string, write: (store: DeviceClaims) => Promise<void>): void {
    const store = this.options.store();
    if (!store) {
      // The registry is not open (yet): the table stays behind the files, which still decide.
      return;
    }
    const settled = write(store).catch((error: unknown) => {
      logger.warn(
        `[DeviceClaims] Cannot ${what} in the host-wide table: ${errorMessage(error)}`,
        error,
      );
    });
    const tracked = settled.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
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
