import type { IosRunnerLaunchSlot } from "./IosRunnerLaunchGate";
import { CtrlProxyLaunchTimeoutError } from "./CtrlProxyLaunchTimeoutError";
import type { IosCtrlProxyRuntime } from "./IosCtrlProxyRuntime";
import { RemoteServicePortUnavailableError } from "./RemoteServicePortUnavailableError";
import type {
  RunnerLaunchProvenance,
  RunnerStartupProvenance,
  SharedCtrlProxyStart,
} from "./IosCtrlProxyLifecycleSteps";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  createGlobalPerformanceTracker,
  type PerformanceTracker,
} from "../../utils/PerformanceTracker";
import { checkIosCtrlProxyOverride } from "../../utils/iosCtrlProxyOverride";
import { ActionableError } from "../../models/ActionableError";
import {
  CtrlProxyStartOptions,
  IproxyTunnelStartOptions,
  ExternalCtrlProxyProcess,
  ListeningProcess,
  IOS_CTRL_PROXY_DEFAULT_PORT,
  IOS_CTRL_PROXY_HEALTH_POLL_INTERVAL_MS,
  type CtrlProxyProcessLiveness,
} from "./IosCtrlProxyContracts";

interface IosCtrlProxyStartupHost {
  assertDeviceNotRetired(): void;
  assertDeviceNotSuspended(): void;
  waitForForceRestart(options: CtrlProxyStartOptions): Promise<boolean>;
  startAfterForceRestart(
    options: CtrlProxyStartOptions,
    expectedForceRestartGeneration?: number,
  ): Promise<void>;
  start(options?: CtrlProxyStartOptions): Promise<void>;
  extendHealthPollDeadline(
    sharedStart: SharedCtrlProxyStart,
    callerId: symbol,
    minimumHealthPollDurationMs: number | undefined,
  ): void;
  waitForSharedStart(
    sharedStart: SharedCtrlProxyStart,
    signal: AbortSignal | undefined,
    callerId?: symbol,
  ): Promise<void>;
  checkCtrlProxyProcessLiveness(): Promise<CtrlProxyProcessLiveness>;
  isSimulator(): boolean;
  startProcessSupervision(options?: { healthConfirmed?: boolean }): Promise<void>;
  isRunning(): Promise<boolean>;
  resolveHealthPollMaxAttempts(env?: NodeJS.ProcessEnv): number;
  refreshHealthPollDeadline(sharedStart: SharedCtrlProxyStart): void;
  waitForHealthRestartingUnresponsiveRunner(
    sharedStart: SharedCtrlProxyStart,
    perf: PerformanceTracker,
    delayMs: number,
    windowMs: number,
    firstLaunchOwned: boolean,
  ): Promise<boolean>;
  checkHealthEndpointOnPortForDevice(
    port: number,
    deviceId: string,
    timeoutMs?: number,
    options?: { requireDeviceId?: boolean },
  ): Promise<boolean>;
  adoptServicePort(port: number): void;
  clearCaches(): void;
  sleepForHealthPoll(delayMs: number, signal?: AbortSignal): Promise<void>;
  completeHealthStartupIfDeadlineExtended(
    sharedStart: SharedCtrlProxyStart,
    perf: PerformanceTracker,
    delayMs: number,
  ): Promise<boolean>;
  findListeningProcessesOnPort(port: number): Promise<ListeningProcess[]>;
  formatListeningProcesses(processes: ListeningProcess[]): string;
  startIproxyTunnel(options?: IproxyTunnelStartOptions): Promise<void>;
  restartDeviceProcessAfterHostPortCollision(): Promise<RunnerLaunchProvenance>;
  useRemoteRunner(): boolean;
  findExternalCtrlProxyProcess(): Promise<ExternalCtrlProxyProcess | null>;
  ensureServicePortReadyForLaunch(): Promise<void>;
  forceStopCancelledStartup(): Promise<void>;
  awaitGlobalStartupOrphanRunnerReap(): Promise<void>;
}

/** Whether a usable runner was already up, or how this start obtained the one it must wait for. */
type RunnerStartupPreparation =
  | { ready: true }
  | { ready: false; provenance: RunnerStartupProvenance };

/** Coordinates shared startup, runner reuse, and recovery after a failed health window. */
export class IosCtrlProxyStartup {
  constructor(
    private readonly state: Pick<
      IosCtrlProxyRuntime,
      | "runnerLaunchGate"
      | "forceRestartGeneration"
      | "forceRestartInFlight"
      | "steps"
      | "sharedStart"
      | "timer"
      | "isStopping"
      | "isProcessSupervisorRestarting"
      | "xcTestProcessId"
      | "servicePort"
      | "device"
      | "runnerGenerationTokens"
      | "xcTestProcess"
      | "processSupervisor"
      | "tunnelClient"
    >,
    private readonly host: IosCtrlProxyStartupHost,
  ) {}

  private launchSlot?: IosRunnerLaunchSlot;
  private launchStart?: SharedCtrlProxyStart;

  // MARK: - Service Control

  /**
   * Start CtrlProxy
   */
  async start(options: CtrlProxyStartOptions = {}): Promise<void> {
    for (;;) {
      this.host.assertDeviceNotRetired();
      this.host.assertDeviceNotSuspended();
      await this.host.waitForForceRestart(options);
      this.host.assertDeviceNotRetired();
      this.host.assertDeviceNotSuspended();
      const expectedForceRestartGeneration = this.state.forceRestartGeneration;
      if (this.state.forceRestartInFlight) {
        continue;
      }
      return this.host.startAfterForceRestart(options, expectedForceRestartGeneration);
    }
  }

  /** Start the runner after a forced restart. Public so tests can stub the restart launch. */
  async startAfterForceRestart(
    options: CtrlProxyStartOptions,
    expectedForceRestartGeneration?: number,
  ): Promise<void> {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("iOS CtrlProxy startup was aborted");
    }

    let sharedStart = await this.state.steps.waitForNonJoinableStart(options.signal);
    if (
      expectedForceRestartGeneration !== undefined &&
      (this.state.forceRestartGeneration !== expectedForceRestartGeneration ||
        this.state.forceRestartInFlight)
    ) {
      return this.host.start(options);
    }
    if (sharedStart) {
      logger.info("[IOSCtrlProxy] Start already in progress, waiting for it to complete");
    } else {
      const controller = new AbortController();
      const createdStart: SharedCtrlProxyStart = {
        controller,
        completion: Promise.resolve(),
        healthPollDeadlineMs: null,
        defaultHealthPollDeadlineMs: null,
        callerHealthPollDeadlinesMs: new Map(),
        teardownCommitted: false,
        waitingCallers: 0,
        externalWaitingCallers: 0,
        completed: false,
      };
      this.state.sharedStart = createdStart;
      createdStart.completion = this.state.steps
        .startInternal(createdStart)
        .catch(async (error) => {
          await this.state.steps.retireRunnerAfterFinalSharedStartCancellation(createdStart);
          throw error;
        });
      void createdStart.completion
        .finally(() => {
          createdStart.completed = true;
          if (this.state.sharedStart === createdStart) {
            this.state.sharedStart = null;
          }
        })
        .catch((error) => {
          // Startup callers own the failure; this observer drains the cleanup continuation.
          logger.debug(`[IOSCtrlProxy] Startup cleanup rejection observed: ${errorMessage(error)}`);
        });
      sharedStart = createdStart;
    }

    const callerId = Symbol("CtrlProxy startup caller");
    this.host.extendHealthPollDeadline(sharedStart, callerId, options.minimumHealthPollDurationMs);
    return this.host.waitForSharedStart(sharedStart, options.signal, callerId);
  }

  async waitForNonJoinableStart(
    signal: AbortSignal | undefined,
  ): Promise<SharedCtrlProxyStart | null> {
    const sharedStart = this.state.sharedStart;
    if (
      !sharedStart ||
      (!sharedStart.controller.signal.aborted && !sharedStart.teardownCommitted)
    ) {
      return sharedStart;
    }
    logger.info("[IOSCtrlProxy] Waiting for a non-joinable startup to settle before retrying");
    try {
      await this.host.waitForSharedStart(sharedStart, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
    }
    if (this.state.sharedStart === sharedStart) {
      this.state.sharedStart = null;
    }
    return this.state.sharedStart;
  }

  async retireRunnerAfterFinalSharedStartCancellation(
    sharedStart: SharedCtrlProxyStart,
  ): Promise<void> {
    if (
      !sharedStart.controller.signal.aborted ||
      sharedStart.externalWaitingCallers !== 0 ||
      sharedStart.teardownCommitted
    ) {
      return;
    }
    sharedStart.teardownCommitted = true;
    logger.info("[IOSCtrlProxy] Final shared startup waiter cancelled; retiring the runner");
    try {
      await this.host.forceStopCancelledStartup();
    } catch (error) {
      // Cancellation remains the caller-visible outcome even if best-effort retirement fails.
      logger.warn(
        `[IOSCtrlProxy] Failed to retire cancelled CtrlProxy startup: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Internal start implementation (called within mutex)
   */
  async startInternal(sharedStart: SharedCtrlProxyStart): Promise<void> {
    this.launchStart = sharedStart;
    try {
      await this.startWithLaunchSlot(sharedStart);
    } finally {
      this.launchSlot?.release();
      this.launchSlot = undefined;
      this.launchStart = undefined;
    }
  }

  private async acquireLaunchSlot(): Promise<void> {
    if (this.launchSlot) {
      return;
    }
    const sharedStart = this.launchStart ?? this.state.sharedStart;
    if (!sharedStart) {
      throw new Error("Runner launch requires a shared startup");
    }
    const queuedAt = this.state.timer.now();
    // Only callers already waiting when the queue began are owed the credit; a
    // later joiner's budget starts at its own join time.
    const queuedCallers = new Set(sharedStart.callerHealthPollDeadlinesMs.keys());
    this.launchSlot = await this.state.runnerLaunchGate.acquire(sharedStart.controller.signal);
    const waitedMs = this.state.timer.now() - queuedAt;
    if (waitedMs > 0) {
      logger.info(`[IOSCtrlProxy] Runner launch queued for ${waitedMs}ms`);
      for (const [caller, deadline] of sharedStart.callerHealthPollDeadlinesMs) {
        if (queuedCallers.has(caller)) {
          sharedStart.callerHealthPollDeadlinesMs.set(caller, deadline + waitedMs);
        }
      }
      this.host.refreshHealthPollDeadline(sharedStart);
    }
    sharedStart.controller.signal.throwIfAborted();
  }

  private async startWithLaunchSlot(sharedStart: SharedCtrlProxyStart): Promise<void> {
    // Authoritative fail-closed gate (#4221): this is the single chokepoint every
    // launch path funnels through (startDevice, session-reuse in toolRegistry, and
    // discovery-pooled devices that never hit verifyIosDevice/ensureCtrlProxyReady).
    // If a local runner override is set but unusable, refuse to start rather than
    // silently launching the released runner and driving the device with it.
    const iosOverride = await checkIosCtrlProxyOverride();
    if (iosOverride.present && !iosOverride.usable) {
      throw new ActionableError(
        `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH / _IPA_PATH is set but unusable: ${iosOverride.reason}`,
      );
    }

    await this.awaitStartupOrphanRunnerReap();

    this.host.assertDeviceNotRetired();

    logger.info("[IOSCtrlProxy] Starting CtrlProxy");
    this.state.isStopping = false;
    const perf = createGlobalPerformanceTracker();

    const preparation = await this.prepareRunnerForStartup(perf);
    if (preparation.ready) {
      return;
    }
    const { provenance } = preparation;

    // Wait for HTTP health endpoint to be ready. XCUITest can take well over 15s to
    // fully initialize after xcodebuild starts on a loaded CI machine, so the budget
    // is env-configurable (AUTOMOBILE_CTRL_PROXY_HEALTH_MAX_ATTEMPTS) and defaults
    // generous — too short a budget declares failure while the runner is still
    // coming up, which then triggers a kill+respawn livelock (#2834).
    // Keep the configured timeout budget independent of the faster initial polling cadence.
    const delayMs = IOS_CTRL_PROXY_HEALTH_POLL_INTERVAL_MS;
    const defaultHealthPollDurationMs = this.host.resolveHealthPollMaxAttempts() * delayMs;
    const healthPollStartedAt = this.state.timer.now();
    sharedStart.defaultHealthPollDeadlineMs = healthPollStartedAt + defaultHealthPollDurationMs;
    this.host.refreshHealthPollDeadline(sharedStart);

    // Only a cold launch this start spawned is owed the first-launch window. A runner
    // it adopted from host control or deferred to, and a supervisor restart, keep the
    // default budget (#14509).
    if (
      await this.host.waitForHealthRestartingUnresponsiveRunner(
        sharedStart,
        perf,
        delayMs,
        defaultHealthPollDurationMs,
        provenance === "spawned" && !this.state.isProcessSupervisorRestarting,
      )
    ) {
      return;
    }

    // The owned first launch may have raised the shared deadline above the default.
    const timeoutSeconds = Math.round(
      ((sharedStart.healthPollDeadlineMs ?? 0) - healthPollStartedAt) / 1000,
    );
    if (await this.recoverDeferredRunner(sharedStart, perf, delayMs, timeoutSeconds, provenance)) {
      return;
    }

    const heldProcesses = await this.host.findListeningProcessesOnPort(this.state.servicePort);
    if (await this.host.completeHealthStartupIfDeadlineExtended(sharedStart, perf, delayMs)) {
      return;
    }
    if (heldProcesses.length > 0) {
      throw new CtrlProxyLaunchTimeoutError(
        `CtrlProxy failed to start within timeout (${timeoutSeconds}s); port ${this.state.servicePort} ` +
          `still held by ${this.host.formatListeningProcesses(heldProcesses)}`,
      );
    }

    throw new CtrlProxyLaunchTimeoutError(
      `CtrlProxy failed to start within timeout (${timeoutSeconds}s)`,
    );
  }

  /**
   * Reports how this start obtained its runner, explicitly rather than inferred from
   * whether it waited: a `deferred` runner drives hung-runner recovery after the
   * health wait (#2834 review), and only a `spawned` one gets the first-launch
   * window (#14509).
   */
  private async prepareRunnerForStartup(
    perf: PerformanceTracker,
  ): Promise<RunnerStartupPreparation> {
    // Prefer process liveness check over health endpoint: a busy-but-alive CtrlProxy
    // would fail the HTTP health check and incorrectly trigger a restart.
    perf.startOperation("processAliveCheck");
    const liveness = await this.host.checkCtrlProxyProcessLiveness();
    perf.endOperation("processAliveCheck");
    const isAlive = liveness !== "dead";
    if (isAlive) {
      logger.info("[IOSCtrlProxy] CtrlProxy process is alive, skipping start");
      // On physical devices the iproxy tunnel may have been stopped independently
      // (e.g. by a temporary disconnect) while the XCTest process kept running.
      // Re-establishing it here is a no-op when the tunnel is already up, and
      // self-heals the connection when it is not.
      const restarted = this.host.isSimulator() ? null : await this.resumeAliveDeviceRunner(perf);
      if (restarted !== null) {
        return { ready: false, provenance: restarted };
      }
      // A local check answered health just now, which breaks any miss streak;
      // a remote alive-only reuse proved nothing about health and keeps it (#14493).
      await this.host.startProcessSupervision({ healthConfirmed: liveness === "healthy" });
      return { ready: true };
    }

    perf.startOperation("runningCheck");
    const alreadyRunning = await this.host.isRunning();
    perf.endOperation("runningCheck");
    if (alreadyRunning) {
      logger.info("[IOSCtrlProxy] Service is already running");
      await this.host.startProcessSupervision();
      return { ready: true };
    }

    // Check for externally-managed xcodebuild processes (e.g. hot-reload script)
    // before spawning our own to avoid conflicting xcodebuild instances.
    const provenance = this.host.isSimulator()
      ? await this.prepareSimulatorRunner(perf)
      : await this.prepareDeviceRunner(perf);
    return { ready: false, provenance };
  }

  private async recoverDeferredRunner(
    sharedStart: SharedCtrlProxyStart,
    perf: PerformanceTracker,
    delayMs: number,
    timeoutSeconds: number,
    provenance: RunnerStartupProvenance,
  ): Promise<boolean> {
    if (provenance !== "deferred" || this.state.xcTestProcessId === null) {
      return false;
    }
    // Before giving up, adopt the runner if it actually came up healthy on CtrlProxy's
    // default port (env-injection fallback #2731) rather than our reallocated port —
    // the health poll above only checks servicePort, so a runner that bound the default
    // port would look "hung" here. Adopt it instead of killing a healthy runner
    // (#2834 review).
    // Simulators only: a device runner is reachable solely through its tunnel on
    // servicePort, so adopting the default port would leave nothing forwarding it.
    if (
      this.host.isSimulator() &&
      this.state.servicePort !== IOS_CTRL_PROXY_DEFAULT_PORT &&
      (await this.host.checkHealthEndpointOnPortForDevice(
        IOS_CTRL_PROXY_DEFAULT_PORT,
        this.state.device.deviceId,
      ))
    ) {
      logger.info(
        `[IOSCtrlProxy] Deferred-to runner is healthy on default port ${IOS_CTRL_PROXY_DEFAULT_PORT}; ` +
          `adopting it instead of terminating`,
      );
      this.host.adoptServicePort(IOS_CTRL_PROXY_DEFAULT_PORT);
      this.host.clearCaches();
      sharedStart.controller.signal.throwIfAborted();
      await this.host.startProcessSupervision();
      return true;
    }
    if (await this.host.completeHealthStartupIfDeadlineExtended(sharedStart, perf, delayMs)) {
      return true;
    }
    // Otherwise it is genuinely hung. Merely un-tracking it is NOT enough: the process
    // stays alive and its environment carries AUTOMOBILE_DEVICE_ID, so on the next
    // start() findExternalCtrlProxyProcess() would re-adopt it ("external CtrlProxy
    // detected, skipping spawn") and we would defer to the hung runner forever, never
    // respawning (#2834 review — restore stale-runner cleanup after the health wait).
    // Terminate it outright so the next start() spawns a fresh runner.
    //
    // Re-verify ownership right before the kill: the multi-minute health poll above is
    // a window in which our runner could exit and its PID be recycled to a foreign
    // process. Locally, isOwnRunnerProcessAlive re-runs getProcessInfo +
    // isOwnedCtrlProxyRunnerProcess on the tracked PID, so a recycled/foreign PID is
    // no longer identified as ours and we skip the kill, only un-tracking. Under host
    // control the re-verify is PID-strict via `status.data.pid === tracked` — the
    // remote daemon resolves status/stop by deviceId BEFORE pid, so without the
    // PID compare a NEWER runner for this device would alias as "ours" and the stop
    // below could kill it (#2834 review). Residual accepted risk: the status→stop
    // race (runner replaced between the two calls) — the daemon is the sole per-device
    // orchestrator, so within one daemon that window is effectively empty; daemon-side
    // pid-match enforcement is tracked as a follow-up.
    const hungPid = this.state.xcTestProcessId;
    const stillOurs = await this.state.steps.isOwnRunnerProcessAlive();
    if (await this.host.completeHealthStartupIfDeadlineExtended(sharedStart, perf, delayMs)) {
      return true;
    }
    sharedStart.teardownCommitted = true;
    // Suppress the exit-handler auto-restart across the kill + child-exit event only.
    this.state.isStopping = true;
    try {
      if (stillOurs) {
        logger.warn(
          `[IOSCtrlProxy] Deferred-to CtrlProxy runner (PID ${hungPid}) never became ` +
            `healthy within ${timeoutSeconds}s; terminating it so the next start spawns a fresh runner`,
        );
        await this.state.steps.terminateHungRunnerProcess(hungPid);
      } else {
        logger.warn(
          `[IOSCtrlProxy] Tracked runner PID ${hungPid} is no longer our CtrlProxy runner ` +
            `(exited/PID-reused); un-tracking without terminating`,
        );
      }
      this.state.runnerGenerationTokens.delete(hungPid);
      this.state.xcTestProcessId = null;
      this.state.xcTestProcess = null;
      // Host-control mode has no local child-exit event to clear these as a side
      // effect (handleProcessExit), so clear explicitly for both modes — otherwise
      // cachedRunning can serve a stale positive to the next setup() for up to
      // STATUS_CACHE_TTL (#2834 review).
      this.host.clearCaches();
      this.state.processSupervisor.stop();
      await this.state.processSupervisor.start();
    } finally {
      // Do NOT leave isStopping latched across the throw below (#2834 review — MINOR-2):
      // a caller that does not retry start() would otherwise wedge the manager in
      // "stopping", disabling handleProcessExit()/scheduleAutoRestart() self-heal.
      // A late child-exit after this reset is ignored by the untracked-exit guard on
      // the spawn handlers (xcTestProcess was nulled above).
      this.state.isStopping = false;
    }

    return false;
  }

  /**
   * Re-establishes an alive device runner's tunnel. Returns null when the runner was
   * kept, or the provenance of the replacement launched after a host-port collision.
   */
  private async resumeAliveDeviceRunner(
    perf: PerformanceTracker,
  ): Promise<RunnerLaunchProvenance | null> {
    let restarted: RunnerLaunchProvenance | null = null;
    perf.startOperation("iproxyTunnel");
    try {
      await this.host.startIproxyTunnel({ allowServicePortReallocation: false });
    } catch (error) {
      perf.endOperation("iproxyTunnel");
      if (!(error instanceof RemoteServicePortUnavailableError)) {
        throw error;
      }
      logger.warn(
        "[IOSCtrlProxy] Existing CtrlProxy process uses a host port that is no longer available; restarting",
      );
      await this.acquireLaunchSlot();
      perf.startOperation("spawnRunner");
      restarted = await this.host.restartDeviceProcessAfterHostPortCollision();
      perf.endOperation("spawnRunner");
    }
    if (restarted === null) {
      perf.endOperation("iproxyTunnel");
      await this.state.tunnelClient.supervise();
    }
    return restarted;
  }

  /**
   * Physical-device counterpart of {@link prepareSimulatorRunner}: a runner THIS
   * manager launched that is still alive is waited for instead of respawned (#10234).
   * `checkCtrlProxyProcessLiveness()` needs a health answer, and on a local device that
   * only reaches the runner through `iproxy`, so a missing tunnel hides a live
   * runner from it. Repair the tunnel here, then let the health wait (and, if it
   * never answers, the hung-runner termination) take over. Returns `deferred` when an
   * own runner was deferred to, otherwise the launch step's provenance.
   */
  async prepareDeviceRunner(perf: PerformanceTracker): Promise<RunnerStartupProvenance> {
    if (
      !this.host.useRemoteRunner() &&
      this.state.xcTestProcessId !== null &&
      (await this.state.steps.isOwnRunnerProcessAlive())
    ) {
      logger.info(
        `[IOSCtrlProxy] Own CtrlProxy runner (PID ${this.state.xcTestProcessId}) is still alive on ` +
          `device ${this.state.device.deviceId}; ensuring its tunnel and waiting for its health ` +
          `endpoint instead of respawning`,
      );
      perf.startOperation("iproxyTunnel");
      try {
        await this.host.startIproxyTunnel();
      } finally {
        perf.endOperation("iproxyTunnel");
      }
      return "deferred";
    }
    await this.acquireLaunchSlot();
    perf.startOperation("spawnRunner");
    const provenance = await this.state.steps.startOnDevice();
    perf.endOperation("spawnRunner");
    return provenance;
  }

  async prepareSimulatorRunner(perf: PerformanceTracker): Promise<RunnerStartupProvenance> {
    // Decide about OUR OWN tracked runner first. A runner WE already spawned may
    // still be mid-startup: on a loaded CI machine XCUITest can take well past the
    // health-poll budget to answer, so an earlier setup() gave up and this call is a
    // retry while the same runner is still coming up. Its PID is alive but its health
    // endpoint isn't yet. Reclaiming the port here would SIGTERM that starting runner
    // and restart the clock — a livelock under repeated setup calls (#2834). Wait for
    // it instead. Checking this BEFORE the external-process probe is important: that
    // probe discovers our own child xcodebuild (whose PID differs from the tracked
    // shell PID under shell:true) and would otherwise mis-classify it as "external"
    // (#2834 review). A runner that actually came up healthy on the default port
    // instead of our reallocated port (#2731) is handled by the health-wait recovery
    // below, which re-checks the default port and adopts it rather than terminating.
    if (await this.state.steps.isOwnRunnerProcessAlive()) {
      logger.info(
        `[IOSCtrlProxy] Own CtrlProxy runner (PID ${this.state.xcTestProcessId}) is still starting; ` +
          `waiting for its health endpoint instead of respawning`,
      );
      return "deferred";
    }

    perf.startOperation("externalProcessCheck");
    const externalProcess = await this.host.findExternalCtrlProxyProcess();
    const defaultPortIsHealthyForDevice =
      externalProcess === null &&
      !this.host.useRemoteRunner() &&
      this.state.servicePort !== IOS_CTRL_PROXY_DEFAULT_PORT &&
      (await this.host.checkHealthEndpointOnPortForDevice(
        IOS_CTRL_PROXY_DEFAULT_PORT,
        this.state.device.deviceId,
      ));
    perf.endOperation("externalProcessCheck");
    if (externalProcess || defaultPortIsHealthyForDevice) {
      const externalPort = externalProcess?.port ?? IOS_CTRL_PROXY_DEFAULT_PORT;
      // Warn (not info): the daemon is about to serve calls through a runner
      // it did NOT launch (#5561). On a shared host this may be a stale or
      // foreign runner — surfacing it loudly stops results from being
      // misattributed to a local build that never ran.
      logger.warn(
        `[IOSCtrlProxy] Reusing an external CtrlProxy runner this daemon did not launch ` +
          `(port ${externalPort}); skipping spawn. Verify it is the runner you intend to test.`,
      );
      if (externalPort !== this.state.servicePort) {
        this.host.adoptServicePort(externalPort);
      }
      // Health polling follows instead of spawning.
      return "adopted";
    }
    await this.host.ensureServicePortReadyForLaunch();
    await this.acquireLaunchSlot();
    perf.startOperation("spawnRunner");
    const provenance = await this.state.steps.startOnSimulator();
    perf.endOperation("spawnRunner");
    return provenance;
  }

  async awaitStartupOrphanRunnerReap(): Promise<void> {
    if (this.host.isSimulator()) {
      await this.host.awaitGlobalStartupOrphanRunnerReap();
    }
  }
}
