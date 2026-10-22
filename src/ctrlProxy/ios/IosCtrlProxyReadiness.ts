import type { IosCtrlProxyRuntime } from "./IosCtrlProxyRuntime";
import type { RunnerStartupProvenance, SharedCtrlProxyStart } from "./IosCtrlProxyLifecycleSteps";
import { logger } from "../../utils/logger";
import { type PerformanceTracker } from "../../utils/PerformanceTracker";
import { Timer } from "../../utils/SystemTimer";
import { ActionableError } from "../../models/ActionableError";
import {
  IOS_CTRL_PROXY_DEFAULT_PORT,
  IOS_CTRL_PROXY_FIRST_LAUNCH_HEALTH_WINDOW_MULTIPLIER,
  IOS_CTRL_PROXY_MAX_UNRESPONSIVE_RUNNER_RELAUNCHES,
} from "./IosCtrlProxyContracts";

interface IosCtrlProxyReadinessHost {
  isSimulator(): boolean;
  checkHealthEndpointOnPortForDevice(
    port: number,
    deviceId: string,
    timeoutMs?: number,
    options?: { requireDeviceId?: boolean },
  ): Promise<boolean>;
  adoptServicePort(port: number): void;
  clearCaches(): void;
  startProcessSupervision(): Promise<void>;
  assertDeviceNotRetired(): void;
  prepareSimulatorRunner(perf: PerformanceTracker): Promise<RunnerStartupProvenance>;
  prepareDeviceRunner(perf: PerformanceTracker): Promise<RunnerStartupProvenance>;
  checkHealthEndpoint(): Promise<boolean>;
  resolveHealthPollMaxAttempts(env?: NodeJS.ProcessEnv): number;
}

const FAST_HEALTH_POLL_INTERVAL_MS = 100;
const FAST_HEALTH_POLL_WINDOW_MS = 5_000;

// This policy is elapsed-time based; the shared Backoff policies count attempts.
function healthPollDelayMs(elapsedMs: number, delayMs: number): number {
  return elapsedMs < FAST_HEALTH_POLL_WINDOW_MS
    ? Math.min(FAST_HEALTH_POLL_INTERVAL_MS, delayMs)
    : delayMs;
}

/** Shares caller health deadlines and replaces runners that never become ready. */
export class IosCtrlProxyReadiness {
  constructor(
    private readonly state: Pick<
      IosCtrlProxyRuntime,
      | "timer"
      | "xcTestProcessId"
      | "steps"
      | "servicePort"
      | "device"
      | "isStopping"
      | "retiredRunnerPids"
      | "runnerGenerationTokens"
      | "xcTestProcess"
      | "tunnelClient"
    >,
    private readonly host: IosCtrlProxyReadinessHost,
  ) {}

  extendHealthPollDeadline(
    sharedStart: SharedCtrlProxyStart,
    callerId: symbol,
    minimumHealthPollDurationMs: number | undefined,
  ): void {
    if (!minimumHealthPollDurationMs || minimumHealthPollDurationMs <= 0) {
      return;
    }
    sharedStart.callerHealthPollDeadlinesMs.set(
      callerId,
      this.state.timer.now() + minimumHealthPollDurationMs,
    );
    this.refreshHealthPollDeadline(sharedStart);
  }

  removeHealthPollDeadline(sharedStart: SharedCtrlProxyStart, callerId: symbol | undefined): void {
    if (!callerId) {
      return;
    }
    sharedStart.callerHealthPollDeadlinesMs.delete(callerId);
    this.refreshHealthPollDeadline(sharedStart);
  }

  refreshHealthPollDeadline(sharedStart: SharedCtrlProxyStart): void {
    sharedStart.healthPollDeadlineMs = Math.max(
      sharedStart.defaultHealthPollDeadlineMs ?? 0,
      ...sharedStart.callerHealthPollDeadlinesMs.values(),
    );
  }

  /**
   * Waits for the launched runner's health endpoint one launch window at a time
   * (#10649). A caller such as getApple extends the shared poll deadline to its
   * whole acquisition budget; without a per-launch window a runner frozen at
   * launch was polled for that entire budget and never replaced. When a window
   * elapses unanswered while the extended deadline still has time left, the
   * runner is terminated and relaunched, at most
   * {@link MAX_UNRESPONSIVE_RUNNER_RELAUNCHES} times; after the last window it is
   * terminated and startup fails with an actionable error inside the deadline.
   *
   * Only a runner this manager tracks is bounded this way; an adopted external
   * runner keeps the whole deadline, as before. Only a first launch spawned by
   * this start raises the shared default deadline for its full cold-launch
   * window; deferred runners and supervisor restarts retain the existing budget.
   *
   * Returns true once startup completed; false when the shared deadline ended
   * without a relaunch, leaving the caller's existing timeout handling in charge.
   */
  async waitForHealthRestartingUnresponsiveRunner(
    sharedStart: SharedCtrlProxyStart,
    perf: PerformanceTracker,
    delayMs: number,
    windowMs: number,
    firstLaunchOwned: boolean,
  ): Promise<boolean> {
    const launchWindowsMs: number[] = [];
    for (;;) {
      const launchWindowMs =
        launchWindowsMs.length === 0
          ? windowMs * IOS_CTRL_PROXY_FIRST_LAUNCH_HEALTH_WINDOW_MULTIPLIER
          : windowMs;
      launchWindowsMs.push(launchWindowMs);
      const bounded = this.state.xcTestProcessId !== null;
      const launchDeadlineMs = bounded
        ? this.state.timer.now() + launchWindowMs
        : Number.POSITIVE_INFINITY;
      this.extendFirstLaunchDeadline(
        sharedStart,
        firstLaunchOwned && launchWindowsMs.length === 1,
        launchDeadlineMs,
      );
      if (
        await this.state.steps.waitForHealthEndpoint(sharedStart, perf, delayMs, launchDeadlineMs)
      ) {
        await this.state.steps.completeHealthStartup(sharedStart, perf);
        return true;
      }
      const now = this.state.timer.now();
      if (!bounded || now < launchDeadlineMs || (sharedStart.healthPollDeadlineMs ?? 0) <= now) {
        return false;
      }
      if (await this.adoptHealthyDefaultPortRunner(sharedStart)) {
        return true;
      }
      const final = launchWindowsMs.length > IOS_CTRL_PROXY_MAX_UNRESPONSIVE_RUNNER_RELAUNCHES;
      await this.retireUnresponsiveRunner(sharedStart, launchWindowMs, final);
      if (final) {
        const windows = launchWindowsMs.map((ms) => `${Math.round(ms / 1000)}s`).join(", ");
        throw new ActionableError(
          `CtrlProxy runner health check failed: the runner never answered its health ` +
            `endpoint on port ${this.state.servicePort} in any of ${launchWindowsMs.length} launches ` +
            `(windows ${windows}), and each was terminated. The runner may be frozen at ` +
            `launch; check the device or simulator, then retry device acquisition.`,
        );
      }
      await this.relaunchUnresponsiveRunner(sharedStart, perf);
    }
  }

  private extendFirstLaunchDeadline(
    sharedStart: SharedCtrlProxyStart,
    firstLaunch: boolean,
    launchDeadlineMs: number,
  ): void {
    if (!firstLaunch || this.state.xcTestProcessId === null) {
      return;
    }
    // Preserve this floor when a joining caller later adds/removes its budget.
    sharedStart.defaultHealthPollDeadlineMs = Math.max(
      sharedStart.defaultHealthPollDeadlineMs ?? 0,
      launchDeadlineMs,
    );
    sharedStart.healthPollDeadlineMs = Math.max(
      sharedStart.healthPollDeadlineMs ?? 0,
      launchDeadlineMs,
    );
  }

  /**
   * A simulator runner can come up on CtrlProxy's default port instead of our
   * reallocated one (env-injection fallback #2731), which looks unresponsive on
   * servicePort. Adopt it rather than terminating a healthy runner.
   */
  private async adoptHealthyDefaultPortRunner(sharedStart: SharedCtrlProxyStart): Promise<boolean> {
    if (
      !this.host.isSimulator() ||
      this.state.servicePort === IOS_CTRL_PROXY_DEFAULT_PORT ||
      !(await this.host.checkHealthEndpointOnPortForDevice(
        IOS_CTRL_PROXY_DEFAULT_PORT,
        this.state.device.deviceId,
      ))
    ) {
      return false;
    }
    logger.info(
      `[IOSCtrlProxy] Runner is healthy on default port ${IOS_CTRL_PROXY_DEFAULT_PORT}; ` +
        `adopting it instead of terminating`,
    );
    this.host.adoptServicePort(IOS_CTRL_PROXY_DEFAULT_PORT);
    this.host.clearCaches();
    sharedStart.controller.signal.throwIfAborted();
    await this.host.startProcessSupervision();
    return true;
  }

  /**
   * Terminate and untrack a runner whose launch window elapsed unanswered, so the
   * relaunch (or the next start) spawns a fresh runner instead of re-adopting the
   * frozen one. A final retirement makes the shared start non-joinable, as the
   * hung-runner path does, so a late caller starts fresh after it settles.
   */
  private async retireUnresponsiveRunner(
    sharedStart: SharedCtrlProxyStart,
    launchWindowMs: number,
    final: boolean,
  ): Promise<void> {
    const pid = this.state.xcTestProcessId;
    const stillOurs = await this.state.steps.isOwnRunnerProcessAlive(pid);
    if (final) {
      sharedStart.teardownCommitted = true;
    }
    this.state.isStopping = true;
    try {
      if (stillOurs && pid !== null) {
        // isStopping alone does not gate the child exit handler, which would abort
        // this start and schedule a duplicate supervisor restart (#10653).
        this.state.retiredRunnerPids.add(pid);
        logger.warn(
          `[IOSCtrlProxy] CtrlProxy runner (PID ${pid}) did not answer its health endpoint ` +
            `within ${Math.round(launchWindowMs / 1000)}s of launch; terminating it` +
            (final ? "" : " and relaunching"),
        );
        await this.state.steps.terminateHungRunnerProcess(pid);
      } else {
        logger.warn(
          `[IOSCtrlProxy] Tracked runner PID ${pid} is no longer our CtrlProxy runner ` +
            `(exited/PID-reused); un-tracking without terminating`,
        );
      }
      if (this.state.xcTestProcessId === pid) {
        if (pid !== null) {
          this.state.runnerGenerationTokens.delete(pid);
        }
        this.state.xcTestProcessId = null;
        this.state.xcTestProcess = null;
      }
      this.host.clearCaches();
    } finally {
      this.state.isStopping = false;
    }
  }

  private async relaunchUnresponsiveRunner(
    sharedStart: SharedCtrlProxyStart,
    perf: PerformanceTracker,
  ): Promise<void> {
    if (sharedStart.controller.signal.aborted) {
      throw sharedStart.controller.signal.reason ?? new Error("iOS CtrlProxy startup was aborted");
    }
    this.host.assertDeviceNotRetired();
    if (this.host.isSimulator()) {
      await this.host.prepareSimulatorRunner(perf);
    } else {
      await this.host.prepareDeviceRunner(perf);
    }
  }

  async waitForHealthEndpoint(
    sharedStart: SharedCtrlProxyStart,
    perf: PerformanceTracker,
    delayMs: number,
    launchDeadlineMs: number = Number.POSITIVE_INFINITY,
  ): Promise<boolean> {
    perf.startOperation("healthPolling");
    const pollStartedAt = this.state.timer.now();
    let attempts = 0;
    // A joining caller can move the shared deadline while this polls; the launch
    // window (#10649) only ever shortens it.
    const deadlineMs = (): number =>
      Math.min(sharedStart.healthPollDeadlineMs ?? 0, launchDeadlineMs);
    for (;;) {
      if (sharedStart.controller.signal.aborted) {
        throw (
          sharedStart.controller.signal.reason ?? new Error("iOS CtrlProxy startup was aborted")
        );
      }
      attempts++;
      if (await this.host.checkHealthEndpoint()) {
        perf.endOperation("healthPolling");
        return true;
      }
      if (attempts > 1 && attempts % 10 === 0) {
        logger.info(
          `[IOSCtrlProxy] Still waiting for service... (attempt ${attempts}, ` +
            `${Math.max(0, deadlineMs() - this.state.timer.now())}ms remaining)`,
        );
      }
      const remainingPollMs = deadlineMs() - this.state.timer.now();
      if (remainingPollMs <= 0) {
        perf.endOperation("healthPolling");
        return false;
      }
      await this.sleepForHealthPoll(
        Math.min(
          healthPollDelayMs(this.state.timer.now() - pollStartedAt, delayMs),
          remainingPollMs,
        ),
        sharedStart.controller.signal,
      );
    }
  }

  async completeHealthStartup(
    sharedStart: SharedCtrlProxyStart,
    _perf: PerformanceTracker,
  ): Promise<void> {
    logger.info("[IOSCtrlProxy] HTTP health endpoint is ready");
    this.host.clearCaches();
    await this.host.startProcessSupervision();

    // Health and WebSocket upgrades share one listener, so health proves it is ready.
    sharedStart.controller.signal.throwIfAborted();

    if (!this.host.isSimulator()) {
      await this.state.tunnelClient.supervise();
    }
  }

  async completeHealthStartupIfDeadlineExtended(
    sharedStart: SharedCtrlProxyStart,
    perf: PerformanceTracker,
    delayMs: number,
  ): Promise<boolean> {
    if ((sharedStart.healthPollDeadlineMs ?? 0) <= this.state.timer.now()) {
      return false;
    }
    if (!(await this.state.steps.waitForHealthEndpoint(sharedStart, perf, delayMs))) {
      return false;
    }
    await this.state.steps.completeHealthStartup(sharedStart, perf);
    return true;
  }

  waitForSharedStart(
    sharedStart: SharedCtrlProxyStart,
    signal: AbortSignal | undefined,
    callerId?: symbol,
  ): Promise<void> {
    sharedStart.waitingCallers++;
    if (callerId) {
      sharedStart.externalWaitingCallers++;
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        sharedStart.waitingCallers--;
        if (callerId) {
          sharedStart.externalWaitingCallers--;
        }
        this.removeHealthPollDeadline(sharedStart, callerId);
        if (!sharedStart.completed && sharedStart.waitingCallers === 0) {
          sharedStart.controller.abort(
            signal?.reason ?? new Error("iOS CtrlProxy startup has no remaining callers"),
          );
        }
        callback();
      };
      const onAbort = () =>
        settle(() => {
          reject(signal?.reason ?? new Error("iOS CtrlProxy startup was aborted"));
        });

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      void sharedStart.completion.then(
        () => settle(resolve),
        (error) => settle(() => reject(error)),
      );
    });
  }

  async waitForReconnectStartup(
    sharedStart: SharedCtrlProxyStart,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const controller = new AbortController();
    const fallbackDeadlineMs =
      this.state.timer.now() + this.host.resolveHealthPollMaxAttempts() * 500;
    let timeout: ReturnType<Timer["setTimeout"]> | undefined;
    const scheduleDeadline = () => {
      const remainingMs =
        Math.max(fallbackDeadlineMs, sharedStart.healthPollDeadlineMs ?? 0) -
        this.state.timer.now();
      timeout = this.state.timer.setTimeout(
        () => {
          if (
            Math.max(fallbackDeadlineMs, sharedStart.healthPollDeadlineMs ?? 0) >
            this.state.timer.now()
          ) {
            scheduleDeadline();
            return;
          }
          controller.abort(
            new Error("iOS CtrlProxy shared startup exceeded its recovery deadline"),
          );
        },
        Math.max(0, remainingMs),
      );
    };
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
    scheduleDeadline();
    try {
      await this.waitForSharedStart(sharedStart, controller.signal);
    } finally {
      if (timeout) {
        this.state.timer.clearTimeout(timeout);
      }
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async sleepForHealthPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await this.state.timer.sleep(delayMs);
      return;
    }
    if (signal.aborted) {
      throw signal.reason ?? new Error("iOS CtrlProxy startup was aborted");
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () =>
        settle(() => {
          reject(signal.reason ?? new Error("iOS CtrlProxy startup was aborted"));
        });
      signal.addEventListener("abort", onAbort, { once: true });
      void this.state.timer.sleep(delayMs).then(
        () => settle(resolve),
        (error) => settle(() => reject(error)),
      );
    });
  }
}
