/**
 * Watches the process that owns a managed slot execution (epic #11172, #11176).
 *
 * The stdio proxy launched with a managed-slot config holds its sessions for the execution's
 * lifetime, renewing their owner lease every 2 s. A living orphan proxy must not keep renewing after
 * the execution it served is gone, so the proxy checks, on its own short cadence, that:
 *
 * - its declared execution owner (by default the parent it was launched by) is still running, and
 * - it has not been re-parented (the launching parent died and init or a subreaper adopted it).
 *
 * Either loss fires `onOwnerLost` exactly once; the caller then releases the execution's sessions
 * and shuts the proxy down. Stdin EOF is the third end-of-execution signal and is already handled
 * by the process-wide stdin shutdown handler, which closes the proxy the same way.
 */

import type { Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";

/** How often the owner is checked. With a ~1.5 s bounded release this keeps death-to-release ≲ 2.5 s. */
export const EXECUTION_OWNER_CHECK_INTERVAL_MS = 1_000;

export type ExecutionOwnerLossReason = "owner-exited" | "parent-changed";

export interface ExecutionOwnerProcessProbe {
  /** Whether the pid names a running process (`utils/processLiveness.isProcessRunning`). */
  isProcessRunning(pid: number): boolean;
  /** This process's current parent pid (`process.ppid`). */
  currentParentPid(): number;
}

export interface ExecutionOwnerWatchOptions {
  /** The parent pid this proxy was launched by. */
  launchParentPid: number;
  /** A declared supervising process; defaults to {@link launchParentPid}. */
  ownerPid?: number;
  onOwnerLost: (reason: ExecutionOwnerLossReason) => void | Promise<void>;
  intervalMs?: number;
}

export class ExecutionOwnerWatch {
  private handle: NodeJS.Timeout | undefined;
  private lost: ExecutionOwnerLossReason | undefined;
  private readonly ownerPid: number;
  private readonly intervalMs: number;

  constructor(
    private readonly options: ExecutionOwnerWatchOptions,
    private readonly probe: ExecutionOwnerProcessProbe,
    private readonly timer: Timer,
  ) {
    this.ownerPid = options.ownerPid ?? options.launchParentPid;
    this.intervalMs = options.intervalMs ?? EXECUTION_OWNER_CHECK_INTERVAL_MS;
  }

  /** Start checking; also checks once now, so an owner already gone at launch is caught. */
  start(): void {
    if (this.handle !== undefined || this.lost !== undefined) {
      return;
    }
    this.handle = this.timer.setInterval(() => {
      this.check();
    }, this.intervalMs);
    this.check();
  }

  stop(): void {
    if (this.handle !== undefined) {
      this.timer.clearInterval(this.handle);
      this.handle = undefined;
    }
  }

  /** The loss already reported, if any. */
  get lossReason(): ExecutionOwnerLossReason | undefined {
    return this.lost;
  }

  /** One check. Reports a loss once, then stops checking. */
  check(): ExecutionOwnerLossReason | undefined {
    if (this.lost !== undefined) {
      return this.lost;
    }
    const reason = this.judge();
    if (reason === undefined) {
      return undefined;
    }
    this.lost = reason;
    this.stop();
    logger.warn(
      `[ExecutionOwnerWatch] Managed execution owner lost (${reason}; owner pid ${this.ownerPid}, ` +
        `launch parent ${this.options.launchParentPid}); releasing the execution's sessions`,
    );
    void Promise.resolve()
      .then(() => this.options.onOwnerLost(reason))
      .catch((error: unknown) => {
        // The owner is gone and nobody awaits this; the daemon's no-heartbeat release (~10 s)
        // still frees the sessions once this process exits, so log the failure and move on.
        logger.warn(
          `[ExecutionOwnerWatch] Releasing after owner loss failed: ${errorMessage(error)}`,
          error,
        );
      });
    return reason;
  }

  private judge(): ExecutionOwnerLossReason | undefined {
    if (this.probe.currentParentPid() !== this.options.launchParentPid) {
      return "parent-changed";
    }
    return this.probe.isProcessRunning(this.ownerPid) ? undefined : "owner-exited";
  }
}
