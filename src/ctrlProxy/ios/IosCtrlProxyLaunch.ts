import { classifyRunnerLaunchOutput } from "./IosRunnerLaunchFailure";
import type { IosCtrlProxyRuntime } from "./IosCtrlProxyRuntime";
import type { RunnerLaunchProvenance } from "./IosCtrlProxyLifecycleSteps";
import { runnerQueryTimeoutEnv } from "./runnerQueryTimeoutEnv";
import { runnerHierarchyPairCaptureEnv } from "./runnerHierarchyPairCaptureEnv";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { ActionableError } from "../../models/ActionableError";
import type { HostChildProcess as ChildProcess } from "../../utils/HostCommandExecutor";
import { AMBIENT_ENV, ENV, readEnvBool, readEnvRaw } from "../../config/env";
import type { LivenessProbe } from "../../utils/ProcessSupervisor";
import {
  RemoteCtrlProxyIOSRunner,
  IproxyTunnelStartOptions,
  IOS_CTRL_PROXY_IMPORTANT_OUTPUT_MARKERS,
} from "./IosCtrlProxyContracts";

interface IosCtrlProxyLaunchHost {
  useRemoteRunner(): boolean;
  adoptServicePort(port: number): void;
  ensureRemoteServicePortAvailable(options?: { allowReallocation?: boolean }): Promise<void>;
  resolveTargetBundleId(): string | undefined;
  assertDeviceNotRetired(): void;
  ensureLocalServicePortAllocatedAndAvailable(): Promise<void>;
  trackStartedXcodebuild(child: ChildProcess): void;
  startIproxyTunnel(options?: IproxyTunnelStartOptions): Promise<void>;
  stopIproxyTunnel(options?: {
    clearDevicePort?: boolean;
    stopSupervisor?: boolean;
  }): Promise<void>;
  retireTrackedDeviceRunnerBeforeSpawn(): Promise<void>;
  checkHealthEndpoint(): Promise<boolean>;
  isProcessRunning(pid: number): Promise<boolean>;
}

/** Tolerate brief host starvation without replacing a live XCTest runner. */
export const IOS_CTRL_PROXY_CONSECUTIVE_HEALTH_MISS_THRESHOLD = 3;

/** Launches local or remote XCTest runners and supervises their process events. */
export class IosCtrlProxyLaunch {
  /**
   * Bumped for every runner this launch starts or adopts. A health-miss streak is
   * scoped to one (PID, launch generation) pair, so a replacement that the OS
   * hands the retired runner's PID still starts with no misses (#14494).
   */
  private runnerLaunchGeneration = 0;
  private consecutiveHealthMisses = 0;
  private supervisedPid: number | null = null;
  private supervisedLaunchGeneration = 0;
  constructor(
    private readonly state: Pick<
      IosCtrlProxyRuntime,
      | "runnerLaunchFailures"
      | "servicePort"
      | "remoteRunnerAvailability"
      | "remoteRunner"
      | "sharedStart"
      | "xcTestProcessId"
      | "xcTestProcess"
      | "device"
      | "builder"
      | "steps"
      | "runnerAbortController"
      | "xcodebuild"
      | "appBundleGuard"
      | "signingManager"
      | "tunnelClient"
      | "retiredRunnerPids"
      | "processClient"
      | "runnerGenerationTokens"
      | "processSupervisor"
      | "isProcessSupervisorRestarting"
      | "retainRunnerTrackingOnSupervisorExit"
    >,
    private readonly host: IosCtrlProxyLaunchHost,
    private readonly healthMissThreshold = IOS_CTRL_PROXY_CONSECUTIVE_HEALTH_MISS_THRESHOLD,
  ) {}

  private requiresRemoteDeviceTunnelRestart(port: number | undefined): port is number {
    return typeof port === "number" && port !== this.state.servicePort;
  }

  private hasRunningRemoteProcess(
    status: Awaited<ReturnType<RemoteCtrlProxyIOSRunner["status"]>>,
  ): status is { success: boolean; data: { running: boolean; pid?: number; port?: number } } {
    return status.success && !!status.data?.running;
  }

  private assertRemoteRunnerStarted(
    result: Awaited<ReturnType<RemoteCtrlProxyIOSRunner["start"]>>,
  ): asserts result is { success: boolean; data: { pid: number; message: string; port?: number } } {
    if (!result.success || !result.data) {
      throw new Error(result.error || "Remote runner failed to start CtrlProxy");
    }
  }

  private optionalRemoteXctestrunPath(path: string | null): string | undefined {
    return path || undefined;
  }

  private deviceSigningArguments(signing: {
    buildSettings: string[];
    allowProvisioningUpdates: boolean;
  }): string[] {
    const signingArgs = [...signing.buildSettings];
    if (signing.allowProvisioningUpdates) {
      signingArgs.unshift("-allowProvisioningUpdates");
    }
    return signingArgs;
  }

  private async isRemoteRunnerAvailable(): Promise<boolean> {
    if (!this.state.remoteRunnerAvailability) {
      this.state.remoteRunnerAvailability = this.state.remoteRunner.isAvailable();
    }
    return this.state.remoteRunnerAvailability;
  }

  /**
   * Rejects a remote start that completes after stop() cancels the shared start.
   * The fence must run before a returned port is adopted or a physical-device
   * tunnel is reconfigured, because shutdown has already begun clearing ownership.
   */
  async fenceLateRemoteStartAfterShutdown(runnerPid: number): Promise<void> {
    const startupAbort = this.state.sharedStart?.controller.signal;
    if (!startupAbort?.aborted) {
      return;
    }

    // Publish before the remote RPC: shutdown's bounded force-stop stage must be
    // able to find this runner even when the best-effort admission cleanup hangs.
    this.state.xcTestProcessId = runnerPid;
    this.state.xcTestProcess = null;
    const stopResult = await this.state.remoteRunner
      .stop({
        deviceId: this.state.device.deviceId,
        pid: runnerPid,
      })
      .catch((error): null => {
        logger.warn(
          `[IOSCtrlProxy] Failed to stop remote runner that completed after shutdown: ${errorMessage(error)}`,
        );
        return null;
      });
    if (stopResult && !stopResult.success) {
      logger.warn(
        `[IOSCtrlProxy] Failed to stop remote runner that completed after shutdown: ` +
          `${stopResult.error ?? "remote runner reported an unsuccessful stop"}`,
      );
    }
    if (stopResult?.success && this.state.xcTestProcessId === runnerPid) {
      this.state.xcTestProcessId = null;
    }
    throw startupAbort.reason ?? new Error("iOS CtrlProxy startup was cancelled by stop()");
  }

  async startOnSimulator(): Promise<RunnerLaunchProvenance> {
    logger.info("[IOSCtrlProxy] Starting CtrlProxy on simulator");

    if (this.host.useRemoteRunner()) {
      if (!(await this.isRemoteRunnerAvailable())) {
        throw new Error("Remote runner not available for CtrlProxy startup");
      }

      const existingProcess = await this.state.remoteRunner.status({
        deviceId: this.state.device.deviceId,
      });
      const existingServicePort = existingProcess.data?.port;
      if (
        this.hasRunningRemoteProcess(existingProcess) &&
        typeof existingServicePort === "number"
      ) {
        logger.info(
          `[IOSCtrlProxy] Reusing remote CtrlProxy process on service port ${existingServicePort}`,
        );
        this.host.adoptServicePort(existingServicePort);
        this.trackLaunchedRunner(existingProcess.data.pid ?? null, null);
        return "adopted";
      }

      await this.host.ensureRemoteServicePortAvailable();

      const xctestrunPath = await this.state.builder.getXctestrunPath("simulator");
      const bundleId = this.host.resolveTargetBundleId();
      this.host.assertDeviceNotRetired();
      const result = await this.state.remoteRunner.start({
        deviceId: this.state.device.deviceId,
        port: this.state.servicePort,
        xctestrunPath: this.optionalRemoteXctestrunPath(xctestrunPath),
        bundleId,
      });

      this.assertRemoteRunnerStarted(result);

      this.trackLaunchedRunner(result.data.pid, null);
      await this.state.steps.fenceLateRemoteStartAfterShutdown(result.data.pid);

      if (typeof result.data.port === "number") {
        this.host.adoptServicePort(result.data.port);
      }
      return "spawned";
    }

    // Use xcodebuild test-without-building (same approach as physical devices).
    // simctl spawn is unreliable on Xcode 26.3+ (NSPOSIXErrorDomain code=2).
    const xctestrunPath = await this.state.builder.getXctestrunPath("simulator");
    if (!xctestrunPath) {
      throw new Error(
        "CtrlProxy xctestrun not found for simulator. Download the CtrlProxy bundle before starting.",
      );
    }

    // Re-verify the runner binary hash (and refuse a foreign-owned derived-data
    // tree) IMMEDIATELY before launch, closing the verify→execute TOCTOU window
    // left by post-extract verification alone (issue #4759).
    await this.state.builder.verifyRunnerBinaryBeforeLaunch("simulator");

    const timeout = readEnvRaw(AMBIENT_ENV.CTRL_PROXY_IOS_TIMEOUT) || "86400";
    const bundleId = this.host.resolveTargetBundleId();
    await this.host.ensureLocalServicePortAllocatedAndAvailable();

    // The runner reads CTRL_PROXY_IOS_PORT from its OWN ProcessInfo.environment.
    // `xcodebuild test-without-building` does not forward the host process env
    // (or SIMCTL_CHILD_*) into the in-simulator runner — the only channel that
    // reaches it is the xctestrun's per-target EnvironmentVariables dict. Inject
    // there so the runner binds the allocated port instead of its hardcoded
    // default 8765 (issue #2731).
    const runnerEnv: Record<string, string> = {
      CTRL_PROXY_IOS_PORT: String(this.state.servicePort),
      CTRL_PROXY_IOS_TIMEOUT: timeout,
      AUTOMOBILE_DEVICE_ID: this.state.device.deviceId,
      ...runnerQueryTimeoutEnv(process.env),
      // Simulator only: a physical device cannot write to a host path.
      ...runnerHierarchyPairCaptureEnv(process.env),
    };
    if (bundleId) {
      runnerEnv[AMBIENT_ENV.CTRL_PROXY_IOS_BUNDLE_ID.name] = bundleId;
      logger.info(
        `[IOSCtrlProxy] Passing CTRL_PROXY_IOS_BUNDLE_ID=${bundleId} to runner via xctestrun`,
      );
    }
    const runnerXctestrunPath = await this.state.builder.writeRunnerEnvironment(
      xctestrunPath,
      runnerEnv,
      this.state.device.deviceId,
    );

    const args = [
      "test-without-building",
      "-xctestrun",
      runnerXctestrunPath,
      "-destination",
      `platform=iOS Simulator,id=${this.state.device.deviceId}`,
      "-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
    ];

    logger.info(
      "[IOSCtrlProxy] Using xcodebuild test-without-building to start runner on simulator",
    );

    // The streaming client uses piped stdio rather than exec(), so verbose
    // hierarchy dumps cannot exhaust an output buffer.
    // runnerEnv is ALSO set on the host xcodebuild process env — not for the runner
    // (it can't see host env) but so the daemon can later discover, own, and recover
    // this process by reading its env via `ps eww` (see findExternalXcodebuildCtrlProxyProcess
    // / isDaemonManagedSimulatorXcodebuildProcess).
    // `xcodebuild` itself becomes the detached process-group leader. This keeps
    // terminateProcessTree's group cleanup effective without a shell wrapper.
    // The signal is THIS manager's own runnerAbortController, never the ambient
    // per-request signal (issue #6410) — the runner is shared across every
    // session targeting this device and must outlive whichever request started
    // it; only stop()/forceRestart() abort this controller.
    this.state.runnerAbortController = new AbortController();
    this.host.assertDeviceNotRetired();
    const child = await this.state.xcodebuild.startStreaming(args, {
      detached: true,
      env: { ...process.env, ...runnerEnv },
      stdio: ["ignore", "pipe", "pipe"],
      signal: this.state.runnerAbortController.signal,
      startupSignal: this.state.sharedStart?.controller.signal,
    });

    child.on("error", (error) => {
      // Ignore events from a process we no longer track (e.g. hung-recovery already
      // tore it down and cleared tracking) so a late error can't double-run cleanup
      // or schedule an auto-restart of a deliberately-removed runner (#2834 review).
      if (this.state.xcTestProcess !== child || this.isRetiredRunnerEvent(child, "error")) {
        return;
      }
      logger.warn(`[IOSCtrlProxy] xcodebuild test error: ${error.message}`);
      this.handleProcessExit();
    });

    child.on("exit", (code, signal) => {
      if (code !== 0 || signal) {
        logger.warn(`[IOSCtrlProxy] xcodebuild test exited: code=${code}, signal=${signal}`);
      }
      // Same untracked-exit guard as the error handler: after hung-recovery (or stop())
      // has already cleaned up and untracked this child, its late exit event must not
      // re-enter handleProcessExit and race an auto-restart against the caller.
      if (this.state.xcTestProcess !== child || this.isRetiredRunnerEvent(child, "exit")) {
        return;
      }
      this.handleProcessExit();
    });

    this.host.trackStartedXcodebuild(child);
    return "spawned";
  }

  // Runner-identification predicates (hasDeviceIdentity, isCtrlProxyRunnerCommand,
  // isDirectCtrlProxyRunnerCommand, isDaemonManagedSimulatorXcodebuildProcess and its
  // supporting shape/shell helpers) now live solely on IosCtrlProxyProcessClient — see
  // IosCtrlProxyProcessClient.ts. Keeping copies here let them silently diverge
  // (#6372 follow-up); callers in this file delegate to `this.processClient` /
  // `IosCtrlProxyProcessClient` instead.

  async startOnDevice(): Promise<RunnerLaunchProvenance> {
    logger.info("[IOSCtrlProxy] Starting CtrlProxy on physical device");

    if (this.host.useRemoteRunner()) {
      if (!(await this.isRemoteRunnerAvailable())) {
        throw new Error("Remote runner not available for CtrlProxy startup");
      }

      const existingProcess = await this.state.remoteRunner.status({
        deviceId: this.state.device.deviceId,
      });
      const existingDevicePort = existingProcess.data?.port;
      if (this.hasRunningRemoteProcess(existingProcess) && typeof existingDevicePort === "number") {
        logger.info(
          `[IOSCtrlProxy] Reusing remote CtrlProxy process on device port ${existingDevicePort}`,
        );
        this.trackLaunchedRunner(existingProcess.data.pid ?? null, null);
        await this.host.startIproxyTunnel({ devicePort: existingDevicePort });
        return "adopted";
      }

      const xctestrunPath = await this.state.builder.getXctestrunPath("device");
      await this.host.startIproxyTunnel();
      await this.state.appBundleGuard.verifyInstalledAppBundle();

      const bundleId = this.host.resolveTargetBundleId();
      this.host.assertDeviceNotRetired();
      const result = await this.state.remoteRunner.start({
        deviceId: this.state.device.deviceId,
        port: this.state.servicePort,
        xctestrunPath: this.optionalRemoteXctestrunPath(xctestrunPath),
        bundleId,
      });

      this.assertRemoteRunnerStarted(result);

      // A shutdown can begin at the following await or either tunnel await.
      // Publish first so its bounded force-stop can always recover this runner.
      this.trackLaunchedRunner(result.data.pid, null);
      await this.state.steps.fenceLateRemoteStartAfterShutdown(result.data.pid);

      const resultDevicePort = result.data.port;
      if (this.requiresRemoteDeviceTunnelRestart(resultDevicePort)) {
        logger.info(
          `[IOSCtrlProxy] Host-control CtrlProxy process is listening on device port ${resultDevicePort}; restarting tunnel`,
        );
        await this.host.stopIproxyTunnel();
        await this.host.startIproxyTunnel({ devicePort: resultDevicePort });
      }
      return "spawned";
    }

    // For physical devices, we need to use iproxy for port forwarding
    // and run the XCUITest via xcodebuild with device destination
    const xctestrunPath = await this.state.builder.getXctestrunPath("device");
    if (!xctestrunPath) {
      throw new Error(
        "CtrlProxy xctestrun not found for device. Download the CtrlProxy bundle before starting.",
      );
    }

    // Re-verify the runner binary hash (and refuse a foreign-owned derived-data
    // tree) IMMEDIATELY before launch, closing the verify→execute TOCTOU window
    // left by post-extract verification alone (issue #4759).
    await this.state.builder.verifyRunnerBinaryBeforeLaunch("device");

    await this.host.ensureLocalServicePortAllocatedAndAvailable();
    await this.host.startIproxyTunnel();
    await this.state.appBundleGuard.verifyInstalledAppBundle();

    const signing = await this.state.signingManager.resolveSigningForDevice(
      this.state.device.deviceId,
    );
    signing.warnings.forEach((warning) => logger.warn(`[IOSCtrlProxy] ${warning}`));
    this.assertTunnelForwardsServicePort();

    const signingArgs = this.deviceSigningArguments(signing);

    const bundleId = this.host.resolveTargetBundleId();

    // Deliver the allocated port to the on-device runner via the xctestrun's
    // EnvironmentVariables. A bare `CTRL_PROXY_IOS_PORT=...` xcodebuild token is
    // a BUILD SETTING, not a runner env var, so it never reaches the runner —
    // which then falls back to its default 8765 (issue #2731).
    const runnerEnv: Record<string, string> = {
      CTRL_PROXY_IOS_PORT: String(this.state.servicePort),
      CTRL_PROXY_IOS_TIMEOUT: readEnvRaw(AMBIENT_ENV.CTRL_PROXY_IOS_TIMEOUT) || "86400",
      AUTOMOBILE_DEVICE_ID: this.state.device.deviceId,
      ...runnerQueryTimeoutEnv(process.env),
    };
    if (bundleId) {
      runnerEnv[AMBIENT_ENV.CTRL_PROXY_IOS_BUNDLE_ID.name] = bundleId;
      logger.info(
        `[IOSCtrlProxy] Passing CTRL_PROXY_IOS_BUNDLE_ID=${bundleId} to runner via xctestrun`,
      );
    }
    const runnerXctestrunPath = await this.state.builder.writeRunnerEnvironment(
      xctestrunPath,
      runnerEnv,
      this.state.device.deviceId,
    );

    const args = [
      "test-without-building",
      "-xctestrun",
      runnerXctestrunPath,
      "-destination",
      `id=${this.state.device.deviceId}`,
      "-only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService",
      ...signingArgs,
    ];

    // Use the streaming client so verbose hierarchy dumps are drained without a
    // shell or an output-buffer ceiling.
    // The runner env is ALSO set on the host xcodebuild process env so the daemon
    // can later discover/own/recover this process by reading its env via `ps eww`.
    // xcodebuild itself is the detached process-group leader, so the manager's
    // existing terminateProcessTree() ownership semantics remain intact.
    // The signal is THIS manager's own runnerAbortController, never the ambient
    // per-request signal (issue #6410) — see the simulator call site for why.
    await this.host.retireTrackedDeviceRunnerBeforeSpawn();
    this.state.runnerAbortController = new AbortController();
    this.host.assertDeviceNotRetired();
    const child = await this.state.xcodebuild.startStreaming(args, {
      detached: true,
      env: { ...process.env, ...runnerEnv },
      stdio: ["ignore", "pipe", "pipe"],
      signal: this.state.runnerAbortController.signal,
      startupSignal: this.state.sharedStart?.controller.signal,
    });

    child.on("error", (error) => {
      if (this.state.xcTestProcess !== child) {
        logger.debug(
          `[IOSCtrlProxy] Ignoring error from stale xcodebuild PID ${child.pid ?? "unknown"}`,
        );
        return;
      }
      if (this.isRetiredRunnerEvent(child, "error")) {
        return;
      }
      logger.warn(`[IOSCtrlProxy] xcodebuild test error: ${error.message}`);
      this.handleProcessExit();
    });

    child.on("exit", (code, signal) => {
      if (this.state.xcTestProcess !== child) {
        logger.debug(
          `[IOSCtrlProxy] Ignoring exit from stale xcodebuild PID ${child.pid ?? "unknown"}`,
        );
        return;
      }
      if (this.isRetiredRunnerEvent(child, "exit")) {
        return;
      }
      if (code !== 0 || signal) {
        logger.warn(`[IOSCtrlProxy] xcodebuild test exited: code=${code}, signal=${signal}`);
      }
      this.handleProcessExit();
    });

    this.host.trackStartedXcodebuild(child);
    return "spawned";
  }

  /**
   * Fail fast when the tunnel and the runner would disagree about the host port.
   * The runner is told to listen on `servicePort` and everything dials
   * `localhost:<servicePort>`, so a tunnel forwarding anything else can only end
   * in a health-poll timeout (#10232). Local runners only: the host-control tunnel
   * is owned by the macOS host.
   */
  private assertTunnelForwardsServicePort(): void {
    if (this.state.tunnelClient.localPort === this.state.servicePort) {
      return;
    }
    throw new ActionableError(
      `iproxy tunnel forwards localhost:${this.state.tunnelClient.localPort ?? "none"} but the CtrlProxy ` +
        `runner port is ${this.state.servicePort}; refusing to launch a runner nothing can reach. ` +
        `Retry the call, or restart the daemon if this persists.`,
    );
  }

  trackStartedXcodebuild(child: ChildProcess): void {
    if (child.pid) {
      // A reused PID belongs to this new runner, not to a retired one.
      this.state.retiredRunnerPids.delete(child.pid);
      const token = this.state.processClient.captureProcessGeneration(child.pid);
      // Unavailable launch tokens retain PID-only behavior. Remote-runner PIDs
      // are tracked separately and must never be sampled in this host's namespace.
      this.state.runnerGenerationTokens.delete(child.pid);
      if (token !== undefined) {
        this.state.runnerGenerationTokens.set(child.pid, token);
      }
      this.trackLaunchedRunner(child.pid, child);
      logger.info(`[IOSCtrlProxy] Started xcodebuild test with PID ${child.pid}`);

      // Capture output for debugging
      this.captureProcessOutput(child);
    }
  }

  /** Publish a runner this launch started or adopted, opening a new runner generation. */
  private trackLaunchedRunner(pid: number | null, child: ChildProcess | null): void {
    if (pid !== null) {
      this.state.runnerLaunchFailures.clear(pid);
    }
    this.runnerLaunchGeneration++;
    this.state.xcTestProcessId = pid;
    this.state.xcTestProcess = child;
  }

  /**
   * Capture process output for debugging
   */
  private captureProcessOutput(child: ChildProcess): void {
    if (child.stdout) {
      child.stdout.on("data", (data: Buffer | string) => {
        const output = data.toString().trim();
        this.recordLaunchOutputFailure(child, output);
        if (output && this.shouldPromoteCtrlProxyOutput(output)) {
          logger.info(`[CtrlProxy stdout] ${output.slice(0, 500)}`);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data: Buffer | string) => {
        const output = data.toString().trim();
        this.recordLaunchOutputFailure(child, output);
        if (output && !output.includes("Build Succeeded")) {
          if (this.shouldPromoteCtrlProxyOutput(output)) {
            logger.warn(`[CtrlProxy stderr] ${output.slice(0, 500)}`);
          } else {
            logger.debug(`[CtrlProxy stderr] ${output.slice(0, 500)}`);
          }
        }
      });
    }
  }

  private recordLaunchOutputFailure(child: ChildProcess, output: string): void {
    const failure = classifyRunnerLaunchOutput(output);
    if (failure && child.pid !== undefined && this.state.xcTestProcess === child) {
      this.state.runnerLaunchFailures.record(child.pid, failure);
      logger.warn(
        `[IOSCtrlProxy] Runner launch failure ${failure.reason} (PID ${child.pid}): ${failure.detail}`,
      );
    }
  }

  private shouldPromoteCtrlProxyOutput(output: string): boolean {
    if (readEnvBool(ENV.CTRLPROXY_VERBOSE)) {
      return true;
    }

    const lower = output.toLowerCase();
    return IOS_CTRL_PROXY_IMPORTANT_OUTPUT_MARKERS.some((marker) => lower.includes(marker));
  }

  /**
   * True for an exit/error event from a runner retired for relaunch (#10653); the
   * retirement owns its cleanup, so the event must not reach the supervisor.
   */
  private isRetiredRunnerEvent(child: ChildProcess, event: "exit" | "error"): boolean {
    if (child.pid === undefined || !this.state.retiredRunnerPids.has(child.pid)) {
      return false;
    }
    if (event === "exit") {
      this.state.retiredRunnerPids.delete(child.pid);
      this.state.runnerGenerationTokens.delete(child.pid);
    }
    logger.debug(`[IOSCtrlProxy] Ignoring ${event} from retired xcodebuild PID ${child.pid}`);
    return true;
  }

  /**
   * Handle process exit
   */
  private handleProcessExit(): void {
    this.state.processSupervisor.processExited();
  }

  /**
   * Arm (or re-arm) runner supervision. Re-arming alone keeps the miss streak, so
   * a start() that merely finds the runner alive cannot keep resetting it (#13821);
   * `healthConfirmed` is passed only when the caller just saw this runner answer
   * its health endpoint, which ends the streak like a successful probe (#14493).
   */
  async startProcessSupervision(options: { healthConfirmed?: boolean } = {}): Promise<void> {
    if (options.healthConfirmed) {
      this.resetHealthMissStreak();
    }
    if (!this.state.isProcessSupervisorRestarting) {
      await this.state.processSupervisor.start();
    }
  }

  /**
   * Liveness probe for the runner supervisor. Only a probe of the current
   * supervision epoch records anything: once start(), stop() or an exit opens a
   * new epoch the supervisor discards this answer, so a miss counted (or the
   * retain-tracking flag armed) here would outlive it and leak into a later,
   * unrelated exit (#14492). A stale probe reports what it saw and records nothing.
   */
  async isSupervisedCtrlProxyProcessAlive(probe: LivenessProbe): Promise<boolean> {
    const isHealthy = await this.host.checkHealthEndpoint();
    if (!probe.isCurrent()) {
      return isHealthy;
    }
    if (isHealthy) {
      if (this.state.xcTestProcessId !== null) {
        this.state.runnerLaunchFailures.clear(this.state.xcTestProcessId);
      }
      this.resetHealthMissStreak();
      return true;
    }
    const pid = this.state.xcTestProcessId;
    if (!pid) {
      this.resetHealthMissStreak();
      logger.warn("[IOSCtrlProxy] XCTest process is not tracked, health endpoint not responding");
      return false;
    }

    const processRunning = this.host.useRemoteRunner()
      ? await this.state.steps.isOwnRunnerProcessAlive()
      : await this.host.isProcessRunning(pid);
    if (!probe.isCurrent()) {
      return processRunning;
    }
    if (!processRunning) {
      this.resetHealthMissStreak();
      logger.warn("[IOSCtrlProxy] XCTest process crashed, health endpoint not responding");
      return false;
    }
    return this.recordLiveRunnerHealthMiss();
  }

  /** Count a miss by the live tracked runner; false once the streak reaches the threshold. */
  private recordLiveRunnerHealthMiss(): boolean {
    if (
      this.supervisedPid !== this.state.xcTestProcessId ||
      this.supervisedLaunchGeneration !== this.runnerLaunchGeneration
    ) {
      // A different runner than the streak belongs to: it starts from zero.
      this.resetHealthMissStreak();
    }
    this.consecutiveHealthMisses++;
    if (this.consecutiveHealthMisses < this.healthMissThreshold) {
      logger.warn(
        `[IOSCtrlProxy] Live XCTest runner missed health probe ${this.consecutiveHealthMisses}/${this.healthMissThreshold}; retaining it`,
      );
      return true;
    }
    this.resetHealthMissStreak();
    logger.warn(
      `[IOSCtrlProxy] Live XCTest runner missed ${this.healthMissThreshold} consecutive health probes; treating the runner as unhealthy`,
    );
    // The supervisor's onExit would otherwise untrack this still-alive runner, and
    // the restart it schedules would then launch a second one beside it (#10234).
    if (this.state.xcTestProcessId !== null) {
      this.state.runnerLaunchFailures.record(this.state.xcTestProcessId, {
        reason: "supervisor-unhealthy",
        detail: `Missed ${this.healthMissThreshold} consecutive health probes`,
      });
    }
    this.state.retainRunnerTrackingOnSupervisorExit = true;
    return false;
  }

  /** Start an empty streak owned by the currently tracked runner. */
  private resetHealthMissStreak(): void {
    this.consecutiveHealthMisses = 0;
    this.supervisedPid = this.state.xcTestProcessId;
    this.supervisedLaunchGeneration = this.runnerLaunchGeneration;
  }
}
