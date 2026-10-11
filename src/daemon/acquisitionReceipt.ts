import { AsyncLocalStorage } from "node:async_hooks";
import type { Platform } from "../models";
import type { Session, SessionCacheData } from "./sessionManager";

/** The old device stays quarantined until delivery commits cleanup or undo cancels it. */
export interface DeferredRebindCleanup {
  readonly settled: Promise<void>;
  commit(): void;
  /** True only when undo prevented every restore from starting. */
  cancel(): boolean;
  /** Resume the retained device's TTL/lease after its cache has been put back. */
  resumeRetainedState(): void;
}

/**
 * What one acquisition created, filled in while it runs. A caller whose result never reaches its
 * client hands it back to be undone, which takes back exactly this and nothing a reused session
 * or an already running device owned before the call (#11565, #11593).
 */
export interface AcquisitionReceipt {
  /**
   * The session id this request's client chose itself (`setActiveDevice`), set before anything
   * is minted. The client knows the id although the call never answers, and names it again on
   * its retry: a cancellation at any point of the mint must leave the id free to be created.
   */
  clientChosenSessionId?: string;
  deferredRebindCleanup?: DeferredRebindCleanup;
  /**
   * The session this acquisition minted. Absent when it reused or moved an existing one.
   * `activityGeneration` is the session's at the mint: it advances whenever anyone resolves the
   * session for a call, reuses it for another acquisition or heartbeats it.
   */
  minted?: {
    readonly session: Session;
    readonly deviceId: string;
    readonly activityGeneration: number;
    /**
     * The client chose this session's id (`setActiveDevice`), so it knows the id although the
     * call never answered: taking the session back must leave the id free to be created again.
     */
    readonly clientSuppliedId?: boolean;
  };
  /**
   * The existing session this call moved to `deviceId`, and the device it held before.
   * `cacheData` is what the session cached for that device when the move began. A rebind discards
   * it, so moving the session back puts back the part that still describes the device (display
   * pin, readiness, observation baselines), including overrides when deferred cleanup was cancelled.
   */
  rebound?: {
    readonly session: Session;
    readonly deviceId: string;
    readonly fromDeviceId: string;
    readonly fromPlatform: Platform;
    readonly cacheData: SessionCacheData;
  };
  /**
   * The device this call booted or created. `rollBack` stops what it booted and deletes what it
   * created, under the device's lifecycle lease and only while no session holds the device.
   */
  started?: { rollBack(reason: unknown): Promise<void> };
}

/** The record of a session an acquisition just minted for `deviceId`. */
export function mintedSession(
  session: Session,
  deviceId: string,
  clientSuppliedId = false,
): NonNullable<AcquisitionReceipt["minted"]> {
  return {
    session,
    deviceId,
    activityGeneration: session.activityGeneration,
    ...(clientSuppliedId ? { clientSuppliedId } : {}),
  };
}

/** The caller's receipt, or a private one for an acquisition whose caller keeps none. */
export function receiptOrNew(receipt: AcquisitionReceipt | undefined): AcquisitionReceipt {
  return receipt ?? {};
}

const requestReceipt = new AsyncLocalStorage<AcquisitionReceipt>();

/** Run one acquiring request with `receipt` as the record of everything it creates. */
export function runWithAcquisitionReceipt<T>(receipt: AcquisitionReceipt, run: () => T): T {
  return requestReceipt.run(receipt, run);
}

/** The receipt of the acquiring request this code runs for, when there is one. */
export function requestAcquisitionReceipt(): AcquisitionReceipt | undefined {
  return requestReceipt.getStore();
}

/** The answer is delivered (or another call holds it): old-device cleanup now belongs to release. */
export function commitAcquisition(receipt: AcquisitionReceipt): void {
  receipt.deferredRebindCleanup?.commit();
}
