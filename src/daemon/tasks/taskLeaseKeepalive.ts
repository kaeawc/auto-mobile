import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";

export interface TaskLeaseHoldRequest {
  readonly taskId: string;
  /** The MCP session key that owns the task. */
  readonly ownerKey: string;
  /** The device session whose lease the task keeps alive. */
  readonly sessionUuid: string;
}

/**
 * Owner decision (2026-10-18, #4668): a task that holds a device keeps that session's device
 * lease alive until its work ends, including work continuing after detached cancellation
 * (#13090), so the client need not heartbeat for it. The task layer calls {@link hold} when
 * the work names its device session and the returned release once the work settles.
 */
export interface TaskLeaseKeepalive {
  hold(request: TaskLeaseHoldRequest): () => void;
}

/** Holds nothing: where no session manager serves leases (direct stdio, tests). */
export const noopTaskLeaseKeepalive: TaskLeaseKeepalive = {
  hold(request) {
    logger.debug(
      `[TASKS] No lease keepalive wired; task ${request.taskId} does not hold session ${request.sessionUuid}`,
    );
    return () => {};
  },
};

/**
 * The part of the session manager a held lease renews through: the same `recordHeartbeat` the
 * socket and HTTP heartbeat routes call, so a held task is one more owner heartbeat, not a
 * second liveness path. `peekSession` judges without releasing an expired session, and returns
 * the same object for as long as one session incarnation lives, so a hold fences its renewals
 * to the incarnation it captured.
 */
export interface TaskLeaseSessions {
  peekSession(sessionId: string): { readonly heartbeatTimeoutMs: number } | null;
  recordHeartbeat(sessionId: string): void;
}

/** How often a held lease is renewed, at most; a shorter session lease renews at half of it. */
export const DEFAULT_TASK_LEASE_RENEW_INTERVAL_MS = 1_000;
const MIN_TASK_LEASE_RENEW_INTERVAL_MS = 50;

export interface HeartbeatTaskLeaseKeepaliveDeps {
  /** Resolved per renewal: absent while the daemon has no session manager. */
  readonly sessions: () => TaskLeaseSessions | undefined;
  readonly timer?: Timer;
  readonly renewIntervalMs?: number;
}

interface ActiveHold {
  readonly release: () => void;
  interval?: NodeJS.Timeout;
}

/**
 * Keeps a task's device session alive by heartbeating it on the owner's behalf (#4668): once at
 * {@link hold} and then on an interval under the session's heartbeat timeout, until the
 * returned release runs (the work settled), the session is gone, or {@link releaseAll} runs at
 * daemon shutdown. It renews only the owner lease, never the idle clocks.
 */
export class HeartbeatTaskLeaseKeepalive implements TaskLeaseKeepalive {
  private readonly timer: Timer;
  private readonly renewIntervalMs: number;
  private readonly active = new Set<ActiveHold>();
  private isClosed = false;

  constructor(private readonly deps: HeartbeatTaskLeaseKeepaliveDeps) {
    this.timer = deps.timer ?? defaultTimer;
    this.renewIntervalMs = deps.renewIntervalMs ?? DEFAULT_TASK_LEASE_RENEW_INTERVAL_MS;
  }

  /** True once {@link releaseAll} ran: this keeper holds nothing more. */
  get closed(): boolean {
    return this.isClosed;
  }

  /** The holds not yet released. */
  get heldCount(): number {
    return this.active.size;
  }

  hold(request: TaskLeaseHoldRequest): () => void {
    const { taskId, sessionUuid } = request;
    const session = this.isClosed ? null : this.deps.sessions()?.peekSession(sessionUuid);
    if (!session) {
      logger.debug(
        `[TASKS] Task ${taskId} holds no lease: session ${sessionUuid} is not live${this.isClosed ? " (daemon stopping)" : ""}`,
      );
      return () => {};
    }
    const hold: ActiveHold = {
      release: () => {
        if (!this.active.delete(hold)) {
          return;
        }
        if (hold.interval !== undefined) {
          this.timer.clearInterval(hold.interval);
        }
        logger.debug(`[TASKS] Task ${taskId} released session ${sessionUuid}`);
      },
    };
    this.active.add(hold);
    const renew = () => {
      const sessions = this.deps.sessions();
      if (sessions?.peekSession(sessionUuid) !== session) {
        // The session ended (released, replaced or expired) under the task: nothing to keep. A
        // session recreated under the same uuid is a different incarnation the task never held.
        logger.debug(`[TASKS] Task ${taskId} stops holding ended session ${sessionUuid}`);
        hold.release();
        return;
      }
      sessions.recordHeartbeat(sessionUuid);
    };
    renew();
    if (!this.active.has(hold)) {
      return hold.release;
    }
    hold.interval = this.timer.setInterval(renew, this.intervalFor(session.heartbeatTimeoutMs));
    logger.info(`[TASKS] Task ${taskId} holds session ${sessionUuid}`);
    return hold.release;
  }

  /** Daemon shutdown: stop renewing every held lease and refuse new holds. */
  releaseAll(): number {
    this.isClosed = true;
    const holds = [...this.active];
    for (const hold of holds) {
      hold.release();
    }
    return holds.length;
  }

  private intervalFor(heartbeatTimeoutMs: number): number {
    const half = Math.floor(heartbeatTimeoutMs / 2);
    return Math.max(MIN_TASK_LEASE_RENEW_INTERVAL_MS, Math.min(this.renewIntervalMs, half));
  }
}
