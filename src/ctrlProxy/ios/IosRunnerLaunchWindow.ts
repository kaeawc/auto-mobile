import type { BackoffPolicy } from "../../utils/Backoff";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import type { RunnerLaunchProgressProbe } from "./IosRunnerLaunchProgress";
import {
  IOS_CTRL_PROXY_LAUNCH_PROGRESS_THRESHOLD_MS,
  IOS_CTRL_PROXY_MAX_PROGRESS_LAUNCH_MS,
} from "./IosCtrlProxyContracts";

/** One launch's progress accounting, independent of the bounded relaunch count. */
export class IosRunnerLaunchWindow {
  private previousCpuMs: number | null = null;
  private extensions = 0;
  private readonly startedAt: number;
  deadlineMs: number;

  constructor(
    private readonly timer: Timer,
    private readonly probe: RunnerLaunchProgressProbe,
    private readonly backoff: BackoffPolicy,
    private readonly identity: { pid: number; deviceId: string },
    windowMs: number,
  ) {
    this.startedAt = timer.now();
    this.deadlineMs = this.startedAt + windowMs;
  }

  get ceilingReached(): boolean {
    return this.timer.now() - this.startedAt >= IOS_CTRL_PROXY_MAX_PROGRESS_LAUNCH_MS;
  }

  async sample(): Promise<number | null> {
    try {
      const cpuMs = await this.probe.sample(this.identity.pid, this.identity.deviceId);
      if (cpuMs === null) {
        logger.warn("[IOSCtrlProxy] Runner launch progress sample unavailable");
      }
      return cpuMs;
    } catch (error) {
      logger.warn(`[IOSCtrlProxy] Runner launch progress probe failed: ${errorMessage(error)}`);
      return null;
    }
  }

  async initialize(): Promise<void> {
    this.previousCpuMs = await this.sample();
  }

  async extend(callerDeadlineMs: number): Promise<boolean> {
    if (this.ceilingReached || this.timer.now() >= callerDeadlineMs) {
      return false;
    }
    const cpuMs = await this.sample();
    const deltaMs = cpuMs !== null && this.previousCpuMs !== null ? cpuMs - this.previousCpuMs : 0;
    this.previousCpuMs = cpuMs;
    if (deltaMs < IOS_CTRL_PROXY_LAUNCH_PROGRESS_THRESHOLD_MS) {
      return false;
    }
    const next = Math.min(
      this.deadlineMs + this.backoff.delayForAttempt(++this.extensions),
      this.startedAt + IOS_CTRL_PROXY_MAX_PROGRESS_LAUNCH_MS,
      callerDeadlineMs,
    );
    if (next <= this.timer.now()) {
      return false;
    }
    this.deadlineMs = next;
    logger.info(
      `[IOSCtrlProxy] Extending runner launch window: CPU +${deltaMs}ms, ` +
        `elapsed ${this.timer.now() - this.startedAt}ms, deadline in ${next - this.timer.now()}ms`,
    );
    return true;
  }
}
