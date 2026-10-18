/**
 * Process-wide bookkeeping over the CtrlProxy forward leases that live clients
 * hold (#10497, #10690): which devices hold one, how busy each is, and how to
 * give them up idle or at shutdown. The client registry itself stays with
 * AndroidCtrlProxyClient; this module sees it only through
 * {@link ForwardLeaseClientRegistry}.
 */
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { Timer } from "../../../utils/SystemTimer";
import type { CtrlProxyForwardLease } from "./CtrlProxyForwardLease";

/** The slice of a client the lease bookkeeping needs. */
export interface ForwardLeaseClient {
  readonly deviceId: string;
  readonly forwardLease: Pick<CtrlProxyForwardLease, "isHeld" | "getAcquiredAt" | "release">;
  readonly readinessHolds: number;
  getRequestActivity(): { inFlightRequests: number; lastActivityAt: number | undefined };
  close(): Promise<void>;
  /** Mark that shutdown released the lease before this client's close finished (#10690). */
  markForwardLeaseForceReleased(): void;
}

/** Read/evict access to the live clients, supplied by the owner of the registry. */
export interface ForwardLeaseClientRegistry {
  singletonEntries(): Array<[string, ForwardLeaseClient]>;
  singleton(deviceId: string): ForwardLeaseClient | undefined;
  /** Detached observers (one-read clients) currently alive. */
  observers(): ForwardLeaseClient[];
  /** Remove the device's singleton and return it, or `null` when none. */
  evictSingleton(deviceId: string): ForwardLeaseClient | null;
  clearSingletons(): void;
}

export interface ForwardLeaseActivity {
  inFlightRequests: number;
  idleForMs: number | null;
}

/** Devices whose singleton client holds the cross-process forwarding lease. */
export function heldForwardLeaseDeviceIds(registry: ForwardLeaseClientRegistry): string[] {
  return registry
    .singletonEntries()
    .filter(([, client]) => client.forwardLease.isHeld?.() === true)
    .map(([deviceId]) => deviceId);
}

/**
 * CtrlProxy use of a device by this process: requests in flight through its
 * singleton and any detached observer, and time since the last request or
 * since the lease was taken, whichever is later. `idleForMs` is `null` when
 * this process neither holds the lease nor has used the device.
 */
export function forwardLeaseActivity(
  registry: ForwardLeaseClientRegistry,
  deviceId: string,
  timer: Timer,
): ForwardLeaseActivity {
  const singleton = registry.singleton(deviceId);
  const clients = [
    singleton,
    ...registry.observers().filter((observer) => observer.deviceId === deviceId),
  ].filter((client): client is ForwardLeaseClient => client !== undefined);
  const activities = clients.map((client) => client.getRequestActivity());
  const observers = clients.length - (singleton === undefined ? 0 : 1);
  const lastTimes = [
    ...activities.map((activity) => activity.lastActivityAt),
    singleton?.forwardLease.getAcquiredAt?.(),
  ].filter((time): time is number => time !== undefined);
  return {
    // A live detached observer is a read in progress even between its requests.
    inFlightRequests:
      activities.reduce((sum, activity) => sum + activity.inFlightRequests, 0) +
      observers +
      clients.reduce((sum, client) => sum + client.readinessHolds, 0),
    idleForMs: lastTimes.length === 0 ? null : Math.max(0, timer.now() - Math.max(...lastTimes)),
  };
}

/**
 * Give up an idle device's forwarding lease: evict the singleton first so a new
 * call builds a fresh client that re-acquires the lease, then close the old
 * one, which removes its forward and releases it.
 */
export async function releaseIdleForwardLease(
  registry: ForwardLeaseClientRegistry,
  deviceId: string,
): Promise<void> {
  const client = registry.evictSingleton(deviceId);
  if (!client) {
    return;
  }
  await client.close();
}

/**
 * Graceful daemon stop: close every client this process holds (removing the
 * forwards it recorded, never unrecorded ones) and release its forwarding
 * leases. Bounded by `timeoutMs`: a hung adb must not block shutdown, so on
 * timeout the leases are released anyway while the recorded forward stays on
 * disk for the next daemon.
 */
export async function releaseForwardLeasesForShutdown(
  registry: ForwardLeaseClientRegistry,
  timer: Timer,
  timeoutMs: number,
): Promise<void> {
  const clients = new Set<ForwardLeaseClient>([
    ...registry.singletonEntries().map(([, client]) => client),
    ...registry.observers(),
  ]);
  if (clients.size === 0) {
    return;
  }
  registry.clearSingletons();
  const closes = [...clients].map((client) =>
    client.close().catch((error) => {
      logger.warn(
        `[CTRL_PROXY] Failed to close CtrlProxy client for ${client.deviceId} during shutdown: ${errorMessage(error)}`,
        error,
      );
    }),
  );
  const timedOut = Symbol("ctrlproxy shutdown release timeout");
  try {
    await raceWithDeadline(Promise.all(closes), {
      timer,
      timeoutMs,
      label: "CtrlProxy forward lease shutdown release",
      timeoutError: () => timedOut,
    });
  } catch (error) {
    if (error !== timedOut) {
      throw error;
    }
    logger.warn(
      `[CTRL_PROXY] Timed out after ${timeoutMs}ms removing CtrlProxy forwards during shutdown; ` +
        `releasing forwarding leases anyway`,
    );
    for (const client of clients) {
      // A close still stuck on adb must not later remove a forward that a
      // successor daemon creates on the freed lease and port (#10690).
      client.markForwardLeaseForceReleased();
      client.forwardLease.release();
    }
  }
}
