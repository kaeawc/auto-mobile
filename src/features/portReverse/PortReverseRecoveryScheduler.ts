import type { AdbTransportRecoveryReason } from "../../utils/android-cmdline-tools/adbTransportRecoveredSignal";
import { exponentialBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type { PortReverseManager, PortReverseRestoreReport } from "./PortReverseManager";

/** Wait after a recovery event before the first reconcile, so a reconnecting adbd can settle. */
export const PORT_REVERSE_RECOVERY_SETTLE_MS = 1000;
/** Reconcile attempts per recovery episode: the first plus retries while the device comes back. */
export const PORT_REVERSE_RECOVERY_MAX_ATTEMPTS = 5;
/** Delay before retry N (1-based): 1 s, 2 s, 4 s, 8 s, covering ~16 s of an adb reconnect. */
export const PORT_REVERSE_RECOVERY_BACKOFF = exponentialBackoff({
  initialDelayMs: 1000,
  maxDelayMs: 8000,
});

/** What one recovery episode ended with, for logs and tests. */
export type PortReverseRecoveryOutcome =
  | { kind: "restored"; deviceId: string; report: PortReverseRestoreReport }
  | { kind: "failed"; deviceId: string; attempts: number; error: string };

export interface PortReverseRecoverySchedulerDeps {
  manager: Pick<PortReverseManager, "reconcile" | "ownedPorts">;
  timer: Timer;
  backoff?: BackoffPolicy;
  settleMs?: number;
  maxAttempts?: number;
  /** Called once per episode when it ends; defaults to nothing (outcomes are logged regardless). */
  onOutcome?: (outcome: PortReverseRecoveryOutcome) => void;
}

interface Episode {
  reason: AdbTransportRecoveryReason;
  attempt: number;
  timeout: NodeJS.Timeout | null;
  running: boolean;
  /** Another recovery event arrived while a reconcile ran: run once more after it. */
  rerun: boolean;
}

/**
 * Re-applies a device's owned `adb reverse` mappings after its adb transport recovers (#17168), so
 * a mapping dropped by an `adb reconnect`, an adbd restart or a transport blip comes back without
 * the client calling `portReverse` again. Events for one device coalesce into one episode; a
 * reconcile that cannot reach the device, or that fails to re-add a mapping, is retried with
 * backoff. A failure that outlasts the episode is logged, and the mapping stays owned, so the
 * session's next `portReverse` call retries it and reports it in `restoreFailures`. Devices with
 * no owned mappings are ignored, and foreign mappings are never touched (the manager's contract).
 */
export class PortReverseRecoveryScheduler {
  private readonly episodes = new Map<string, Episode>();
  private readonly backoff: BackoffPolicy;
  private readonly settleMs: number;
  private readonly maxAttempts: number;
  private disposed = false;

  constructor(private readonly deps: PortReverseRecoverySchedulerDeps) {
    this.backoff = deps.backoff ?? PORT_REVERSE_RECOVERY_BACKOFF;
    this.settleMs = deps.settleMs ?? PORT_REVERSE_RECOVERY_SETTLE_MS;
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? PORT_REVERSE_RECOVERY_MAX_ATTEMPTS);
  }

  /** The device's adb transport is back (or coming back): schedule a reconcile if it holds mappings. */
  deviceRecovered(deviceId: string, reason: AdbTransportRecoveryReason): void {
    if (this.disposed || this.deps.manager.ownedPorts(deviceId).length === 0) {
      return;
    }
    const episode = this.episodes.get(deviceId);
    if (episode === undefined) {
      const fresh: Episode = { reason, attempt: 0, timeout: null, running: false, rerun: false };
      this.episodes.set(deviceId, fresh);
      this.schedule(deviceId, fresh, this.settleMs);
      return;
    }
    if (episode.running) {
      episode.rerun = true;
    } else {
      // A pending episode already covers this event; it restarts its attempt budget.
      episode.attempt = 0;
    }
  }

  /** Devices with a recovery episode pending or running. */
  pendingDevices(): string[] {
    return [...this.episodes.keys()].sort();
  }

  dispose(): void {
    this.disposed = true;
    for (const episode of this.episodes.values()) {
      if (episode.timeout !== null) {
        this.deps.timer.clearTimeout(episode.timeout);
      }
    }
    this.episodes.clear();
  }

  private schedule(deviceId: string, episode: Episode, delayMs: number): void {
    episode.timeout = this.deps.timer.setTimeout(() => {
      episode.timeout = null;
      void this.run(deviceId, episode);
    }, delayMs);
  }

  private async run(deviceId: string, episode: Episode): Promise<void> {
    episode.running = true;
    episode.rerun = false;
    episode.attempt++;
    let failure: string | undefined;
    let report: PortReverseRestoreReport | undefined;
    try {
      report = await this.deps.manager.reconcile(deviceId);
      if (report.restoreFailures.length > 0) {
        failure = report.restoreFailures.map((f) => `tcp:${f.devicePort}: ${f.error}`).join("; ");
      }
    } catch (error) {
      // Expected while the device is still reconnecting: the retry below covers it.
      failure = errorMessage(error);
      logger.debug(
        `[portReverse] reconcile of ${deviceId} after ${episode.reason} (attempt ${episode.attempt}) failed: ${failure}`,
      );
    }
    episode.running = false;
    if (this.disposed || this.episodes.get(deviceId) !== episode) {
      return;
    }
    if (failure !== undefined && episode.attempt < this.maxAttempts) {
      this.schedule(deviceId, episode, this.backoff.delayForAttempt(episode.attempt));
      return;
    }
    if (failure === undefined && episode.rerun) {
      episode.attempt = 0;
      this.schedule(deviceId, episode, 0);
      return;
    }
    this.episodes.delete(deviceId);
    this.finish(deviceId, episode, failure, report);
  }

  private finish(
    deviceId: string,
    episode: Episode,
    failure: string | undefined,
    report: PortReverseRestoreReport | undefined,
  ): void {
    if (failure !== undefined) {
      logger.warn(
        `[portReverse] could not restore owned reverse mappings on ${deviceId} after ${episode.reason} ` +
          `(${episode.attempt} attempts): ${failure}. The session's next portReverse call retries ` +
          "and reports restoreFailures.",
      );
      this.deps.onOutcome?.({
        kind: "failed",
        deviceId,
        attempts: episode.attempt,
        error: failure,
      });
      return;
    }
    if (report !== undefined && report.restored.length > 0) {
      logger.info(
        `[portReverse] restored ${report.restored.map((p) => `tcp:${p}`).join(", ")} on ${deviceId} after ${episode.reason}`,
      );
    }
    this.deps.onOutcome?.({
      kind: "restored",
      deviceId,
      report: report ?? { restored: [], restoreFailures: [] },
    });
  }
}
