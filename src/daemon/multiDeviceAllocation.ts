import { ActionableError } from "../models";
import type { Timer } from "../utils/SystemTimer";
import type { getAbortSignal } from "../utils/AbortContext";
import type { raceWithDeadline } from "../utils/raceWithDeadline";
import type { DeviceAllocationCriteria, DeviceAllocationRequest } from "./DeviceCriteriaMatcher";
import type { PooledDevice } from "./devicePool";

/**
 * Why the last round of a multi-device allocation did not complete:
 * `queued` \u2014 an earlier conflicting request was still waiting (no attempt made);
 * `busy` \u2014 too few matching devices were idle to claim (no attempt made);
 * `contention` \u2014 an attempt was made and released its claims to retry.
 */
export type MultiDeviceAllocationBlock = "queued" | "busy" | "contention";

export interface MultiDeviceAllocationTicket {
  requests: DeviceAllocationRequest[];
  /**
   * Sessions that already held a pooled device when the ticket last checked
   * whether it can claim (on enqueue and before each claim check, never while
   * its own attempt is in flight). Their devices are never rolled back, so they
   * stay held while it waits.
   */
  heldSessionIds?: ReadonlySet<string>;
}

/** A queued ticket whose pre-existing session pins a device. */
interface PinnedDeviceHolder {
  ticket: MultiDeviceAllocationTicket;
  sessionId: string;
}

/** A deadlocked claim's candidate device pinned by other waiting tickets. */
interface PinnedDeviceWait {
  request: DeviceAllocationRequest;
  deviceId: string;
  holders: PinnedDeviceHolder[];
}

/** Why a deadlocked ticket waits: its edges in the wait-for graph. */
interface DeadlockWait {
  /** Earlier conflicting deadlocked tickets it is queued behind. */
  queuedBehind: MultiDeviceAllocationTicket[];
  /** Pinned devices it needs; empty when unpinned supply alone could serve it. */
  blockedOn: PinnedDeviceWait[];
}

/** Whether each claim (a list of candidate IDs) can get a distinct device. */
function hasCompleteMatching(candidates: readonly (readonly string[])[]): boolean {
  const owner = new Map<string, number>();
  const augment = (index: number, seen: Set<string>): boolean =>
    candidates[index].some((deviceId) => {
      if (seen.has(deviceId)) {
        return false;
      }
      seen.add(deviceId);
      const current = owner.get(deviceId);
      if (current === undefined || augment(current, seen)) {
        owner.set(deviceId, index);
        return true;
      }
      return false;
    });
  return candidates.every((_, index) => augment(index, new Set()));
}

/** Nodes that reach `start` and are reachable from it, including `start`. */
function stronglyConnectedWith<T>(start: T, successors: (node: T) => readonly T[]): Set<T> {
  const reachableFrom = (from: T) => {
    const seen = new Set<T>();
    const pending = [...successors(from)];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(...successors(next));
      }
    }
    return seen;
  };
  const forward = reachableFrom(start);
  if (!forward.has(start)) {
    return new Set([start]);
  }
  return new Set([...forward].filter((node) => node === start || reachableFrom(node).has(start)));
}

function describePinnedWait({ deviceId, holders }: PinnedDeviceWait): string {
  return `'${deviceId}' (session '${holders[0].sessionId}')`;
}

/** Pinned devices each claim waits on, described for an error message. */
function groupPinnedWaits(
  waits: readonly PinnedDeviceWait[],
): Array<{ request: DeviceAllocationRequest; devices: string }> {
  const byRequest = new Map<DeviceAllocationRequest, string[]>();
  for (const wait of waits) {
    byRequest.set(wait.request, [...(byRequest.get(wait.request) ?? []), describePinnedWait(wait)]);
  }
  return [...byRequest].map(([request, devices]) => ({ request, devices: devices.join(", ") }));
}

export interface MultiDeviceAllocationOutcome<T> {
  success: boolean;
  value?: T;
  attempts: number;
  lastBlock?: MultiDeviceAllocationBlock;
}

/** Attempt count for a timeout message, with why no attempt was made when zero (#9950). */
export function describeMultiDeviceAllocationAttempts(
  outcome: Pick<MultiDeviceAllocationOutcome<unknown>, "attempts" | "lastBlock">,
): string {
  const count = `${outcome.attempts} attempts`;
  if (outcome.lastBlock === "queued") {
    return `${count}; still queued behind an earlier multi-device request that was waiting for devices`;
  }
  if (outcome.lastBlock === "busy") {
    return `${count}; too few matching devices were idle to attempt allocation`;
  }
  return count;
}

export interface MultiDeviceAllocationQueuePort {
  readonly timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  readonly getAbortSignal: typeof getAbortSignal;
  readonly raceWithDeadline: typeof raceWithDeadline;
  readonly DEVICE_WAIT_INTERVAL_MS: number;
  deviceHeldByExistingSession(sessionId: string): Readonly<PooledDevice> | undefined;
  heldDeviceDisqualification(
    request: DeviceAllocationRequest,
    device: Readonly<PooledDevice>,
  ): string | undefined;
  getDevicesMatchingCriteria(
    criteria?: DeviceAllocationCriteria,
  ): readonly Readonly<PooledDevice>[];
  hasPendingAndroidRecoveryMatching(criteria?: DeviceAllocationCriteria): boolean;
  potentialSupplyFor(request: DeviceAllocationRequest): readonly Readonly<PooledDevice>[];
  readonly criteriaMatcher: {
    formatCriteriaSummary(criteria?: DeviceAllocationCriteria): string;
  };
}

export class MultiDeviceAllocationQueue {
  // Tickets begin after preflight. Only platform-disjoint requests may
  // overtake earlier waiters; new partial claims are released before waiting.
  private readonly multiDeviceAllocationQueue: MultiDeviceAllocationTicket[] = [];
  private readonly multiDeviceAllocationWaiters = new Set<() => void>();

  constructor(private readonly port: MultiDeviceAllocationQueuePort) {}

  multiDeviceAllocationBlock(ticket: MultiDeviceAllocationTicket): MultiDeviceAllocationBlock {
    return this.isQueuedBehindConflictingRequest(ticket) ? "queued" : "busy";
  }

  isQueuedBehindConflictingRequest(ticket: MultiDeviceAllocationTicket): boolean {
    return this.earlierConflictingTickets(ticket).length > 0;
  }

  /** Earlier queued tickets that `ticket` must wait behind. */
  private earlierConflictingTickets(
    ticket: MultiDeviceAllocationTicket,
  ): MultiDeviceAllocationTicket[] {
    const earlier = this.multiDeviceAllocationQueue.slice(
      0,
      this.multiDeviceAllocationQueue.indexOf(ticket),
    );
    // Comparing live candidate IDs alone misses devices joining later. Use a
    // conservative platform-disjoint rule across both APIs, including wildcards.
    return earlier.filter((waiter) =>
      waiter.requests.some((prior) =>
        ticket.requests.some(
          (request) =>
            !prior.criteria?.platform ||
            !request.criteria?.platform ||
            prior.criteria.platform === request.criteria.platform,
        ),
      ),
    );
  }

  async waitForMultiDeviceRetry(deadlineMs: number): Promise<void> {
    const delay = Math.min(this.port.DEVICE_WAIT_INTERVAL_MS, deadlineMs - this.port.timer.now());
    if (delay <= 0) {
      return;
    }
    let handle: NodeJS.Timeout | undefined;
    let wake: (() => void) | undefined;
    try {
      await this.port.raceWithDeadline(
        () =>
          new Promise<void>((resolve) => {
            wake = resolve;
            this.multiDeviceAllocationWaiters.add(resolve);
            handle = this.port.timer.setTimeout(resolve, delay);
          }),
        {
          timer: this.port.timer,
          signal: this.port.getAbortSignal(),
          label: "Multi-device allocation wait",
        },
      );
    } finally {
      if (wake) {
        this.multiDeviceAllocationWaiters.delete(wake);
      }
      if (handle !== undefined) {
        this.port.timer.clearTimeout(handle);
      }
    }
  }

  notify(): void {
    for (const wake of this.multiDeviceAllocationWaiters) {
      wake();
    }
  }

  enqueue(ticket: MultiDeviceAllocationTicket): void {
    this.recordHeldSessions(ticket);
    this.multiDeviceAllocationQueue.push(ticket);
  }

  /** Snapshots which of the ticket's sessions hold a pooled device right now. */
  recordHeldSessions(ticket: MultiDeviceAllocationTicket): void {
    ticket.heldSessionIds = new Set(
      ticket.requests
        .map((request) => request.sessionId)
        .filter((sessionId) => this.port.deviceHeldByExistingSession(sessionId) !== undefined),
    );
  }

  /**
   * Devices pinned by queued tickets' pre-existing sessions, by device ID. A
   * session may have several queued tickets; each is a holder, in queue order,
   * so the earliest-queued one is named first.
   */
  private pinnedDevicesByTicket(): Map<string, PinnedDeviceHolder[]> {
    const pinned = new Map<string, PinnedDeviceHolder[]>();
    for (const ticket of this.multiDeviceAllocationQueue) {
      for (const sessionId of ticket.heldSessionIds ?? []) {
        const device = this.port.deviceHeldByExistingSession(sessionId);
        if (device) {
          pinned.set(device.id, [...(pinned.get(device.id) ?? []), { ticket, sessionId }]);
        }
      }
    }
    return pinned;
  }

  /**
   * Claims a queued ticket still waits on, or undefined when it is not waiting
   * for devices this analysis can reason about: it claims nothing, a held
   * device is disqualified (the attempt fails fast instead), or a claim has no
   * candidate yet or a pending recovery (inventory may still change).
   */
  private unmetMultiDeviceClaims(
    ticket: MultiDeviceAllocationTicket,
  ): DeviceAllocationRequest[] | undefined {
    const claims: DeviceAllocationRequest[] = [];
    for (const request of ticket.requests) {
      const held = this.port.deviceHeldByExistingSession(request.sessionId);
      if (held && this.port.heldDeviceDisqualification(request, held)) {
        return undefined;
      }
      if (!held || !ticket.heldSessionIds?.has(request.sessionId)) {
        claims.push(request);
      }
    }
    const unknowable = claims.some(
      (request) =>
        this.port.getDevicesMatchingCriteria(request.criteria).length === 0 ||
        this.port.hasPendingAndroidRecoveryMatching(request.criteria),
    );
    return claims.length === 0 || unknowable ? undefined : claims;
  }

  /**
   * Whether `ticket` cannot fill its claims (one distinct device each) without
   * a device pinned by a ticket in `blockers`, yet could with them. Idle,
   * recovering, in-flight and non-waiting sessions' devices may free up, so
   * they count as supply; the ticket's own pinned devices never do, nor do
   * devices allocation can never use (error, unhealthy, unassignable).
   */
  private isDeviceBlockedBy(
    ticket: MultiDeviceAllocationTicket,
    claims: readonly DeviceAllocationRequest[],
    blockers: ReadonlySet<MultiDeviceAllocationTicket>,
    pinned: ReadonlyMap<string, PinnedDeviceHolder[]>,
  ): boolean {
    const pinnedBy = (deviceId: string, by: (other: MultiDeviceAllocationTicket) => boolean) =>
      (pinned.get(deviceId) ?? []).some((holder) => by(holder.ticket));
    const candidates = claims.map((request) =>
      this.port
        .potentialSupplyFor(request)
        .map((device) => device.id)
        .filter((deviceId) => !pinnedBy(deviceId, (other) => other === ticket)),
    );
    const supply = candidates.map((ids) =>
      ids.filter((deviceId) => !pinnedBy(deviceId, (other) => blockers.has(other))),
    );
    return !hasCompleteMatching(supply) && hasCompleteMatching(candidates);
  }

  /**
   * Waiting tickets that can never complete (greatest fixpoint): each is queued
   * behind a conflicting member, or is short of devices that only members pin.
   */
  private findDeadlockedTickets(
    pinned: ReadonlyMap<string, PinnedDeviceHolder[]>,
  ): Map<MultiDeviceAllocationTicket, DeviceAllocationRequest[]> {
    const claimsByTicket = new Map(
      this.multiDeviceAllocationQueue.flatMap((ticket) => {
        const claims = this.unmetMultiDeviceClaims(ticket);
        return claims ? [[ticket, claims] as const] : [];
      }),
    );
    const deadlocked = new Set(claimsByTicket.keys());
    const stuck = (ticket: MultiDeviceAllocationTicket) =>
      this.earlierConflictingTickets(ticket).some((other) => deadlocked.has(other)) ||
      this.isDeviceBlockedBy(ticket, claimsByTicket.get(ticket) ?? [], deadlocked, pinned);
    let changed = true;
    while (changed) {
      const released = [...deadlocked].filter((ticket) => !stuck(ticket));
      released.forEach((ticket) => deadlocked.delete(ticket));
      changed = released.length > 0;
    }
    return new Map([...deadlocked].map((ticket) => [ticket, claimsByTicket.get(ticket) ?? []]));
  }

  /** Why each deadlocked ticket waits: its edges in the wait-for graph. */
  private deadlockWaits(
    deadlocked: ReadonlyMap<MultiDeviceAllocationTicket, DeviceAllocationRequest[]>,
    pinned: ReadonlyMap<string, PinnedDeviceHolder[]>,
  ): Map<MultiDeviceAllocationTicket, DeadlockWait> {
    const members = new Set(deadlocked.keys());
    const pinnedWaits = (ticket: MultiDeviceAllocationTicket, request: DeviceAllocationRequest) =>
      this.port.potentialSupplyFor(request).flatMap((device) => {
        const holders = (pinned.get(device.id) ?? []).filter(
          (holder) => holder.ticket !== ticket && members.has(holder.ticket),
        );
        return holders.length > 0 ? [{ request, deviceId: device.id, holders }] : [];
      });
    return new Map(
      [...deadlocked].map(([ticket, claims]) => {
        const wait: DeadlockWait = {
          queuedBehind: this.earlierConflictingTickets(ticket).filter((other) =>
            members.has(other),
          ),
          blockedOn: this.isDeviceBlockedBy(ticket, claims, members, pinned)
            ? claims.flatMap((request) => pinnedWaits(ticket, request))
            : [],
        };
        return [ticket, wait] as const;
      }),
    );
  }

  /**
   * Fails a multi-device request that is in a cross-session cycle (#9950) of
   * the wait-for graph between queued requests: an edge runs to a request that
   * pins a device this one needs and cannot get elsewhere (counting devices, so
   * several claims cannot share one), or to an earlier conflicting request this
   * one is queued behind. Held devices are never released while a request
   * waits, so no request in the cycle could complete before its timeout. Only
   * the most recently queued member of the cycle fails, so earlier requests keep
   * their place; requests merely waiting on a cycle keep waiting.
   */
  throwIfMultiDeviceAllocationDeadlocked(ticket: MultiDeviceAllocationTicket): void {
    const pinned = this.pinnedDevicesByTicket();
    const deadlocked = this.findDeadlockedTickets(pinned);
    if (!deadlocked.has(ticket)) {
      return;
    }
    const waits = this.deadlockWaits(deadlocked, pinned);
    const successors = (from: MultiDeviceAllocationTicket) => {
      const wait = waits.get(from);
      return [
        ...(wait?.queuedBehind ?? []),
        ...(wait?.blockedOn ?? []).flatMap(({ holders }) => holders.map((h) => h.ticket)),
      ];
    };
    const cycle = stronglyConnectedWith(ticket, successors);
    const queueIndex = (other: MultiDeviceAllocationTicket) =>
      this.multiDeviceAllocationQueue.indexOf(other);
    if (cycle.size < 2 || [...cycle].some((other) => queueIndex(other) > queueIndex(ticket))) {
      return;
    }
    const others = [...cycle]
      .filter((other) => other !== ticket)
      .sort((a, b) => queueIndex(a) - queueIndex(b));
    throw new ActionableError(this.formatAllocationDeadlock(ticket, others, cycle, waits));
  }

  private formatAllocationDeadlock(
    ticket: MultiDeviceAllocationTicket,
    others: readonly MultiDeviceAllocationTicket[],
    cycle: ReadonlySet<MultiDeviceAllocationTicket>,
    waits: ReadonlyMap<MultiDeviceAllocationTicket, DeadlockWait>,
  ): string {
    const held = (member: MultiDeviceAllocationTicket) => {
      const devices = [...(member.heldSessionIds ?? [])].flatMap((sessionId) => {
        const device = this.port.deviceHeldByExistingSession(sessionId);
        return device ? [`'${device.id}' (session '${sessionId}')`] : [];
      });
      return devices.length > 0 ? devices.join(", ") : "no devices";
    };
    const sessions = (member: MultiDeviceAllocationTicket) =>
      member.requests.map((request) => `'${request.sessionId}'`).join(", ");
    const inCycle = (member: MultiDeviceAllocationTicket) => {
      const wait = waits.get(member);
      return {
        blockedOn: (wait?.blockedOn ?? []).flatMap((entry) => {
          const holders = entry.holders.filter((holder) => cycle.has(holder.ticket));
          return holders.length > 0 ? [{ ...entry, holders }] : [];
        }),
        queued: (wait?.queuedBehind ?? []).filter((other) => cycle.has(other)),
      };
    };
    const own = inCycle(ticket);
    const claimLines = groupPinnedWaits(own.blockedOn).map(
      ({ request, devices }) =>
        `Session '${request.sessionId}'${this.port.criteriaMatcher.formatCriteriaSummary(request.criteria)} ` +
        `is waiting for ${devices}, held by waiting requests.\n`,
    );
    const queueLines = own.queued.map(
      (other) =>
        `It is queued behind the earlier waiting request for sessions ${sessions(other)}.\n`,
    );
    const otherLines = others.map((other) => {
      const wait = inCycle(other);
      const devices = [...new Set(wait.blockedOn.map(describePinnedWait))].join(", ");
      return (
        `The waiting request for sessions ${sessions(other)} holds ${held(other)}` +
        (devices ? ` and is waiting for ${devices}` : "") +
        (wait.queued.length > 0 ? " and is queued behind another of these requests" : "") +
        ".\n"
      );
    });
    return (
      `Cannot allocate devices: this request is deadlocked with other waiting multi-device requests.\n` +
      `This request's sessions hold ${held(ticket)}.\n` +
      [...claimLines, ...queueLines, ...otherLines].join("") +
      `Held devices are not released while a request waits, so none of these requests could finish ` +
      `before its allocation timeout. Failing now instead of waiting it out.\n` +
      `Suggestions:\n` +
      `  - Run these plans one after another instead of concurrently\n` +
      `  - Release one of the sessions holding these devices and retry\n` +
      `  - Start another matching device so each request can claim an idle one`
    );
  }

  remove(ticket: MultiDeviceAllocationTicket): void {
    const index = this.multiDeviceAllocationQueue.indexOf(ticket);
    if (index >= 0) {
      this.multiDeviceAllocationQueue.splice(index, 1);
      this.notify();
    }
  }
}
