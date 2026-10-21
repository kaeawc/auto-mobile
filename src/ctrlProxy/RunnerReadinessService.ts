import { runIosRunnerSetup } from "./runIosRunnerSetup";
import {
  READINESS_RETRY_DELAY_MS,
  CTRL_PROXY_ENABLEMENT_VERIFY_BUDGET_MS,
  RUNNER_CONNECT_DIAGNOSTIC_TIMEOUT_MS,
  CTRL_PROXY_REBIND_RECOVERY_POLL_MS,
  CTRL_PROXY_POST_REBIND_RESTART_GRACE_MS,
  CTRL_PROXY_RESTART_MIN_FAILED_PROBES,
  IOS_CTRL_PROXY_MINIMUM_IOS_VERSION,
} from "./RunnerReadinessPolicy";
export { RUNNER_CONNECT_DIAGNOSTIC_TIMEOUT_MS } from "./RunnerReadinessPolicy";
import type { BootedDevice } from "../models";
import { ambientPerfFor, runWithPerfTracker } from "../utils/PerfContext";
import { errorMessage } from "../utils/describeUnknownError";
import {
  acquireDeviceReadinessLock,
  deviceReadinessLockKey,
  type DeviceReadinessLockRelease,
} from "../utils/deviceReadinessLock";
import { compareIosVersions } from "../utils/ios-cmdline-tools/iosVersion";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { DefaultRetryExecutor } from "../utils/retry/RetryExecutor";
import { CtrlProxyInspectionError } from "./CtrlProxyManager";
import { READINESS_PROBE_TIMEOUT_MS, ReadinessPhaseRunner } from "./ReadinessPhaseRunner";
import type {
  AndroidCompatibilityResult,
  ReadinessAttemptContext,
  RunnerReadinessPhase,
  RunnerReadinessRequest,
} from "./RunnerReadinessAttemptContext";
import {
  ReadinessAndroidManager,
  ReadinessClient,
  ReadinessIosClient,
  ReadinessIosManager,
  RunnerReadinessDependencies,
} from "./RunnerReadinessDependencies";
import { RunnerReadinessError } from "./RunnerReadinessError";
import { IosPostSetupReadinessProbe } from "./IosPostSetupReadinessProbe";
import { SYSTEM_UI_ANR_RECOVERY_POLL_MS, SystemUiAnrRecovery } from "./SystemUiAnrRecovery";
import { SystemUiAnrRecoveryRequiredError } from "./SystemUiAnrRecoveryRequiredError";
import { isTerminalLeaseConflict } from "./readinessLeaseConflict";
import { normalizeDiagnostic } from "./runnerReadinessDiagnosticText";
export type {
  AndroidFrameworkReadinessResult,
  AndroidRunnerHealthDiagnostic,
  ReadinessAndroidManager,
  ReadinessClient,
  ReadinessIosClient,
  ReadinessIosManager,
  RunnerReadinessDependencies,
} from "./RunnerReadinessDependencies";
export { normalizeDiagnostic, RunnerReadinessError, SystemUiAnrRecoveryRequiredError };
export type { AndroidCompatibilityResult, RunnerReadinessPhase, RunnerReadinessRequest };

export class RunnerReadinessService {
  private readonly phases: ReadinessPhaseRunner;
  private readonly anrRecovery: SystemUiAnrRecovery;
  private readonly iosPostSetupProbe: IosPostSetupReadinessProbe;

  constructor(private readonly dependencies: RunnerReadinessDependencies) {
    this.phases = new ReadinessPhaseRunner(dependencies.timer);
    this.iosPostSetupProbe = new IosPostSetupReadinessProbe(dependencies, this.phases);
    this.anrRecovery = new SystemUiAnrRecovery(dependencies.timer, this.phases);
  }

  async ensureReady(request: RunnerReadinessRequest): Promise<void> {
    // Setup/provision phases run against `totalDeadlineMs`; the connect/health
    // window is opened later (see `startHealthWindow`) so a cold launch cannot
    // starve it (#5376).
    const context: ReadinessAttemptContext = {
      ...request,
      healthDeadlineMs: null,
      phaseElapsedMs: {},
      lastCtrlProxyRebindMs: Number.NEGATIVE_INFINITY,
      ctrlProxyAccessibilityRebindAttempted: false,
      lastConnectedRecoveryMs: Number.NEGATIVE_INFINITY,
      ctrlProxyProcessRestartAttempted: false,
      lastSuccessfulRebindMs: Number.NEGATIVE_INFINITY,
      failedHealthProbesSinceRecovery: 0,
    };
    const key = deviceReadinessLockKey(request.device.platform, request.device.deviceId);
    const release = await this.acquireReadinessTurn(context, key);
    try {
      request.signal?.throwIfAborted();
      request.assertCanSetup?.();
      await this.ensureReadyUncoordinated(context);
    } finally {
      release();
    }
  }

  private async ensureReadyUncoordinated(context: ReadinessAttemptContext): Promise<void> {
    // Establish the (--debug-perf-gated) ambient tracker around the WHOLE
    // readiness attempt, not just each `runPhase`, so commands issued outside a
    // phase — the pre-phase Android framework probe and the failure-diagnostic
    // ADB reads — also attribute their spans here (see PerfContext). The
    // per-phase `readiness:<phase>` spans still nest underneath.
    const perf = context.perf;
    const run = async (): Promise<void> => {
      if (context.device.platform === "android") {
        await this.ensureAndroidReady(context);
        return;
      }
      await this.ensureIosReady(context);
    };
    if (!perf) {
      return run();
    }
    return runWithPerfTracker(ambientPerfFor(perf), run);
  }

  private async acquireReadinessTurn(
    context: ReadinessAttemptContext,
    key: string,
  ): Promise<DeviceReadinessLockRelease> {
    if (this.phases.remainingForPhase(context, "runner-setup") <= 0) {
      this.phases.fail(context, "runner-setup", 1, "readiness budget exhausted before setup lock", {
        deadlineExhausted: true,
      });
    }
    try {
      // Shared per-device lock (#6227): the session-scoped readiness upgrade in
      // ToolExecutionContext participates in this SAME lock, so an acquisition
      // and an upgrade never reset+setup the same device concurrently.
      return await acquireDeviceReadinessLock(key, {
        timer: this.dependencies.timer,
        signal: context.signal,
        timeoutMs: this.phases.remainingForPhase(context, "runner-setup"),
        timeoutError: () => new Error("readiness setup lock exceeded this request's deadline"),
      });
    } catch (error) {
      // The queued wait also rejects on caller abort; that cancellation must
      // propagate unchanged rather than be reported as a deadline exhaustion,
      // which provisionDevice maps to a RETRYABLE `timeout`.
      this.phases.throwIfCallerCancelled(context, error);
      // Otherwise the lock wait is bounded by the remaining setup budget, so
      // the only failure it can report here is that bound being reached.
      this.phases.fail(context, "runner-setup", 1, normalizeDiagnostic(error), {
        deadlineExhausted: true,
      });
    }
  }

  private async ensureAndroidReady(context: ReadinessAttemptContext): Promise<void> {
    this.phases.throwIfCallerCancelled(context);
    const finishInspection = this.inspectAndroidFrameworkBestEffort(context);
    try {
      let lastDiagnostic = "Android framework readiness budget exhausted";
      await new DefaultRetryExecutor(this.dependencies.timer).executeOrThrow(
        async (attempt) => {
          this.phases.throwIfCallerCancelled(context);
          if (this.phases.remainingForPhase(context, "runner-setup") <= 0) {
            this.phases.fail(context, "runner-setup", attempt, lastDiagnostic, {
              deadlineExhausted: true,
            });
          }
          if (attempt > 1) {
            this.dependencies.getAndroidManager(context.device).resetSetupState();
          }
          await this.ensureAndroidReadyAttempt(context);
          this.phases.throwIfCallerCancelled(context);
        },
        {
          maxAttempts:
            Math.ceil(
              this.phases.remainingForPhase(context, "runner-setup") / READINESS_RETRY_DELAY_MS,
            ) + 1,
          signal: context.signal,
          delays: () =>
            Math.min(
              READINESS_RETRY_DELAY_MS,
              this.phases.remainingForPhase(context, "runner-setup"),
            ),
          // Retry required setup only when Android explicitly reports a missing
          // boot service. Optional inspection never determines readiness.
          shouldRetry: (error) =>
            error instanceof RunnerReadinessError &&
            error.retryableAndroidFrameworkFailure &&
            this.phases.remainingForPhase(context, "runner-setup") > 0,
          onRetry: (error) => {
            lastDiagnostic = normalizeDiagnostic(error);
            logger.debug(`Retrying Android framework setup: ${lastDiagnostic}`);
          },
        },
      );
    } catch (error) {
      this.phases.throwIfCallerCancelled(context, error);
      throw error;
    } finally {
      await finishInspection?.();
      this.phases.throwIfCallerCancelled(context);
    }
  }

  private async ensureAndroidReadyAttempt(context: ReadinessAttemptContext): Promise<void> {
    const manager = this.dependencies.getAndroidManager(context.device);
    const client = this.dependencies.getAndroidClient(context.device);
    if (context.skipCtrlProxyDownload) {
      await this.ensureAndroidReadyWithoutDownloads(context, manager, client);
      return;
    }
    const compatibility = await this.phases.runPhase(
      context,
      "package-compatibility",
      1,
      (signal) =>
        manager.ensureCompatibleVersion(
          {
            allowDownloadWhenInstalled: true,
            bypassVersionCheckCache: false,
          },
          signal,
        ),
    );
    this.assertAndroidCompatibility(context, compatibility);

    // Read sequentially so a transient failure cannot leave a sibling ADB
    // command running when the next setup attempt starts.
    const [installed, enabled] = await this.phases.runPhase(
      context,
      "runner-setup",
      1,
      async (signal) => [await manager.isInstalled(signal), await manager.isEnabled(signal)],
    );
    if (await this.isResponsiveFastPath(context, client, installed && enabled)) {
      await this.anrRecovery.recoverIfPresent(context, client);
      return;
    }

    // A prior readiness request may have exhausted its health budget while the
    // daemon stays alive. Reopen the manager's one-attempt setup gate before
    // this independent request tries to recover a reinstalled or disabled runner.
    // Preserve the caches populated milliseconds earlier in this same attempt;
    // setup mutations and failed-attempt retries still invalidate them.
    manager.reopenSetupGate();
    await this.setupAndroidRunner(context, manager);
    await this.waitForResponsiveClient(context, client, manager);
    await this.anrRecovery.recoverIfPresent(context, client);
  }

  private inspectAndroidFrameworkBestEffort(
    context: ReadinessAttemptContext,
  ): (() => Promise<void>) | undefined {
    const probe = this.dependencies.getAndroidFrameworkReadiness;
    if (!probe) {
      return;
    }
    const remainingMs = Math.max(0, context.totalDeadlineMs - this.dependencies.timer.now());
    if (remainingMs <= 0) {
      return;
    }
    const controller = new AbortController();
    const inspectionSignal = context.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal;
    const timeoutMs = Math.min(READINESS_PROBE_TIMEOUT_MS, remainingMs);
    const timeout = this.dependencies.timer.setTimeout(
      () => controller.abort(new Error("Android framework inspection timed out")),
      timeoutMs,
    );
    // Defer invocation so synchronous injected failures follow the same
    // diagnostic-only rejection path as asynchronous ADB failures.
    const inspection = Promise.resolve()
      .then(() => {
        inspectionSignal.throwIfAborted();
        return probe(context.device, inspectionSignal, timeoutMs);
      })
      .then(
        (result) => {
          if (!result.ready) {
            logger.debug(
              `Android framework inspection is not ready yet: ${
                result.unavailableResources?.join(", ") ?? "unknown resources"
              }${result.diagnostic ? `; ${normalizeDiagnostic(result.diagnostic)}` : ""}`,
            );
          }
        },
        (error: unknown) => {
          // Framework inspection is diagnostic only; required runner readiness
          // below owns the request outcome and cancellation.
          logger.debug(`Android framework inspection failed: ${normalizeDiagnostic(error)}`);
        },
      )
      .finally(() => this.dependencies.timer.clearTimeout(timeout));
    return async () => {
      controller.abort(new Error("Android readiness inspection finished"));
      this.dependencies.timer.clearTimeout(timeout);
      // Bound cleanup even for a broken injected probe that ignores abort;
      // production ADB commands observe the signal and settle here.
      await this.phases.awaitAbortSettlement(inspection);
    };
  }

  private async ensureAndroidReadyWithoutDownloads(
    context: ReadinessAttemptContext,
    manager: ReadinessAndroidManager,
    client: ReadinessClient,
  ): Promise<void> {
    const [installed, enabled] = await this.phases.runPhase(
      context,
      "runner-setup",
      1,
      async (signal) => [await manager.isInstalled(signal), await manager.isEnabled(signal)],
    );
    if (!installed) {
      this.phases.fail(
        context,
        "runner-setup",
        1,
        "CtrlProxy is not installed and runner downloads are disabled",
      );
    }
    const compatible = await this.phases.runPhase(context, "package-compatibility", 1, () =>
      manager.isVersionCompatible(),
    );
    if (!compatible) {
      this.phases.fail(
        context,
        "package-compatibility",
        1,
        "CtrlProxy version mismatch; run without skipCtrlProxyDownload to install a compatible version",
      );
    }
    if (await this.isResponsiveFastPath(context, client, enabled)) {
      await this.anrRecovery.recoverIfPresent(context, client);
      return;
    }
    if (!enabled) {
      await this.phases.runPhase(context, "runner-setup", 1, () => manager.enable());
    }
    await this.waitForResponsiveClient(context, client, manager);
    await this.anrRecovery.recoverIfPresent(context, client);
  }

  private assertAndroidCompatibility(
    context: ReadinessAttemptContext,
    compatibility: AndroidCompatibilityResult,
  ): void {
    const rejected =
      compatibility.status === "failed" ||
      compatibility.status === "skipped" ||
      compatibility.acceptedPreinstalled === true;
    if (!rejected) {
      return;
    }
    const details = [
      compatibility.error,
      compatibility.upgradeError,
      compatibility.reinstallError,
      compatibility.acceptedPreinstalled
        ? "installed package compatibility was not verified"
        : undefined,
      compatibility.status === "skipped" ? "package compatibility check was skipped" : undefined,
    ].filter((value): value is string => Boolean(value));
    this.phases.fail(
      context,
      "package-compatibility",
      1,
      compatibility.cause ?? details.join("; "),
    );
  }

  private async isResponsiveFastPath(
    context: ReadinessAttemptContext,
    client: ReadinessClient,
    runnerConfigured: boolean,
  ): Promise<boolean> {
    if (!runnerConfigured || !client.isConnected()) {
      return false;
    }
    return this.phases.runPhase(context, "runner-health", 1, () =>
      client.verifyServiceReady(1, 0, this.phases.probeTimeout(context)),
    );
  }

  private async setupAndroidRunner(
    context: ReadinessAttemptContext,
    manager: ReadinessAndroidManager,
  ): Promise<void> {
    const setup = await this.phases.runPhase(context, "runner-setup", 1, (signal) =>
      manager.setup(false, context.perf, signal),
    );
    if (!setup.success) {
      this.phases.fail(context, "runner-setup", 1, setup.cause ?? setup.error ?? setup.message);
    }
    const verificationDeadlineMs = Math.min(
      context.totalDeadlineMs,
      this.dependencies.timer.now() + CTRL_PROXY_ENABLEMENT_VERIFY_BUDGET_MS,
    );
    let attempts = 0;
    let installed = false;
    let enabled = false;
    for (;;) {
      attempts++;
      [installed, enabled] = await this.phases.runPhase(
        context,
        "runner-setup",
        attempts,
        async (signal) => [
          await manager.isInstalled(signal),
          await manager.isEnabled(signal, { bypassCache: attempts > 1 }),
        ],
        verificationDeadlineMs,
      );
      if (installed && enabled) {
        return;
      }
      if (!installed || this.dependencies.timer.now() >= verificationDeadlineMs) {
        break;
      }
      this.phases.throwIfCallerCancelled(context);
      await this.dependencies.timer.sleep(
        Math.min(READINESS_RETRY_DELAY_MS, verificationDeadlineMs - this.dependencies.timer.now()),
      );
      this.phases.throwIfCallerCancelled(context);
      if (this.dependencies.timer.now() >= verificationDeadlineMs) {
        break;
      }
      // Android can clear accessibility enablement after a successful setup
      // write. Reconcile the observed disabled state within the same deadline,
      // then require a fresh read before accepting readiness.
      await this.phases.runPhase(
        context,
        "runner-setup",
        attempts,
        () => manager.enable(),
        verificationDeadlineMs,
      );
    }
    if (!installed || !enabled) {
      this.phases.fail(
        context,
        "runner-setup",
        attempts,
        `CtrlProxy state after setup: installed=${installed}, enabled=${enabled}`,
      );
    }
  }

  private async ensureIosReady(context: ReadinessAttemptContext): Promise<void> {
    this.assertIosRuntimeCompatible(context);
    const override = await this.phases.runPhase(context, "runner-setup", 1, () =>
      this.dependencies.checkIosOverride(),
    );
    if (override.present && !override.usable) {
      this.phases.fail(
        context,
        "runner-setup",
        1,
        `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH / _IPA_PATH is set but unusable: ${override.reason ?? "unknown reason"}`,
      );
    }

    await this.phases.runPhase(context, "runner-setup", 1, () =>
      this.dependencies.awaitIosStartupMaintenance(),
    );
    const manager = this.dependencies.getIosManager(context.device);
    let client = this.dependencies.getIosClient(context.device, manager.getServicePort());
    if (client.isConnected()) {
      this.phases.startHealthWindow(context);
      const ready = await this.phases.runPhase(context, "runner-health", 1, () =>
        client.verifyServiceReady(1, 0, this.phases.probeTimeout(context)),
      );
      if (ready) {
        return;
      }
      manager.resetSetupState();
      // A reachable CtrlProxy endpoint can still be unable to produce a
      // hierarchy. In that state setup() would short-circuit on port health,
      // leaving the runner wedged indefinitely. Restart the process so the
      // next health probe uses a fresh observation stream (#5532).
      await this.phases.runPhase(context, "runner-setup", 1, (signal) =>
        manager.forceRestart({
          signal,
          minimumHealthPollDurationMs: this.phases.remainingForPhase(context, "runner-health"),
        }),
      );
      // A cold restart can outlast the original health window. Probe the new
      // process in a fresh window, still capped by the total deadline.
      context.healthDeadlineMs = null;
      // Restart can reallocate the service port when its prior listener became
      // unavailable. Do not let a stale client accept another device's runner.
      client = this.dependencies.getIosClient(context.device, manager.getServicePort());
      await this.waitForResponsiveClient(context, client);
      return;
    }

    if (context.skipCtrlProxyDownload) {
      await this.ensureIosReadyWithoutDownloads(context, manager);
      return;
    }

    // A prior readiness request may have left the setup gate latched
    // (attemptedSetup) with a stale positive from earlier in this daemon's
    // lifetime. Reopen it before this independent request tries setup again,
    // matching the Android path (see :265) and the connected branch above
    // (:613) — otherwise setup() can report "already running" against a
    // runner that died without a local child-exit event (#6416).
    await runIosRunnerSetup(context, manager, this.phases, this.dependencies.iosSetupMaxAttempts);
    // Setup can reallocate a busy port or adopt the runner's actual listener.
    // Resolve the client after launch, just as the force-restart path does.
    client = this.dependencies.getIosClient(context.device, manager.getServicePort());
    await this.ensureIosClientReadyAfterStart(context, manager, client);
  }

  private assertIosRuntimeCompatible(context: ReadinessAttemptContext): void {
    const runtime = context.device.iosVersion ?? context.device.osVersion;
    const comparison = compareIosVersions(runtime, IOS_CTRL_PROXY_MINIMUM_IOS_VERSION);
    if (comparison !== null && comparison < 0) {
      this.phases.fail(
        context,
        "runner-setup",
        1,
        `iOS runtime ${runtime} is below the CtrlProxy minimum ${IOS_CTRL_PROXY_MINIMUM_IOS_VERSION}; select a compatible simulator or device.`,
      );
    }
  }

  private async ensureIosReadyWithoutDownloads(
    context: ReadinessAttemptContext,
    manager: ReadinessIosManager,
  ): Promise<void> {
    const installed = await this.phases.runPhase(context, "runner-setup", 1, () =>
      manager.isInstalled(),
    );
    if (!installed) {
      this.phases.fail(
        context,
        "runner-setup",
        1,
        "CtrlProxy iOS runner is not installed and runner downloads are disabled",
      );
    }
    await this.phases.runPhase(context, "runner-setup", 1, (signal) =>
      manager.start({
        signal,
        minimumHealthPollDurationMs: this.phases.remainingForPhase(context, "runner-setup"),
      }),
    );
    const client = this.dependencies.getIosClient(context.device, manager.getServicePort());
    await this.ensureIosClientReadyAfterStart(context, manager, client);
  }

  private async ensureIosClientReadyAfterStart(
    context: ReadinessAttemptContext,
    manager: ReadinessIosManager,
    initialClient: ReadinessIosClient,
  ): Promise<void> {
    // A single slow first snapshot is not evidence that a just-launched runner
    // needs replacing. Retry unless liveness checks establish that it is dead.
    this.phases.startHealthWindow(context);
    if (await this.iosPostSetupProbe.isResponsive(context, manager, initialClient)) {
      return;
    }

    manager.resetSetupState();
    await this.phases.runPhase(context, "runner-setup", 1, (signal) =>
      manager.forceRestart({
        signal,
        minimumHealthPollDurationMs: this.phases.remainingForPhase(context, "runner-setup"),
      }),
    );
    // A cold restart can outlast the original health window. Probe the new
    // process in a fresh window, still capped by the total deadline.
    context.healthDeadlineMs = null;
    const restartedClient = this.dependencies.getIosClient(
      context.device,
      manager.getServicePort(),
    );
    await this.waitForResponsiveClient(context, restartedClient);
  }

  private async waitForResponsiveClient(
    context: ReadinessAttemptContext,
    client: ReadinessClient,
    androidManager?: ReadinessAndroidManager,
  ): Promise<void> {
    const hold = {
      release: context.device.platform === "android" ? client.beginReadinessHold?.() : undefined,
    };
    try {
      await this.pollResponsiveClient(context, client, hold, androidManager);
    } finally {
      hold.release?.();
    }
  }

  private async pollResponsiveClient(
    context: ReadinessAttemptContext,
    client: ReadinessClient,
    hold: { release: (() => void) | undefined },
    androidManager?: ReadinessAndroidManager,
  ): Promise<void> {
    // Provisioning is done; open the steady-state health window now so a long
    // cold launch above did not consume it (#5376).
    this.phases.startHealthWindow(context);
    let attempts = 0;
    let connected = client.isConnected();
    let phase: RunnerReadinessPhase = connected ? "runner-health" : "runner-connect";
    let lastSystemUiProbeMs = Number.NEGATIVE_INFINITY;
    while (this.phases.remainingForPhase(context, "runner-health") > 0) {
      this.phases.throwIfCallerCancelled(context);
      if (context.device.platform === "android") {
        client = await this.replaceClosedAndroidClient(context, client, hold, attempts);
      }
      attempts++;
      connected = client.isConnected();
      if (!connected) {
        phase = "runner-connect";
        await this.rebindUnhealthyAndroidAccessibilityService(
          context,
          androidManager,
          attempts,
          client,
        );
        connected = await this.phases.runPhase(context, phase, attempts, () =>
          client.waitForConnection(1, 0),
        );
        if (!connected && isTerminalLeaseConflict(client)) {
          await this.failUnresponsiveClient(context, client, phase, attempts);
        }
      }
      if (connected) {
        phase = "runner-health";
        const ready = await this.phases.runPhase(context, phase, attempts, () =>
          client.verifyServiceReady(1, 0, this.phases.probeTimeout(context)),
        );
        if (ready) {
          return;
        }
        await this.recoverConnectedButUnresponsiveAndroid(
          context,
          androidManager,
          client,
          attempts,
        );
      }
      if (
        context.device.platform === "android" &&
        this.dependencies.timer.now() - lastSystemUiProbeMs >= SYSTEM_UI_ANR_RECOVERY_POLL_MS
      ) {
        lastSystemUiProbeMs = this.dependencies.timer.now();
        await this.anrRecovery.recoverIfPresent(context, client);
      }

      const remaining = this.phases.remainingForPhase(context, "runner-health");
      if (remaining > 0) {
        await this.dependencies.timer.sleep(Math.min(READINESS_RETRY_DELAY_MS, remaining));
      }
    }
    await this.failUnresponsiveClient(context, client, phase, attempts);
  }

  private async replaceClosedAndroidClient(
    context: ReadinessAttemptContext,
    client: ReadinessClient,
    hold: { release: (() => void) | undefined },
    attempts: number,
  ): Promise<ReadinessClient> {
    if (!client.isClosed?.()) {
      return client;
    }
    hold.release?.();
    hold.release = undefined;
    const replacement = this.dependencies.getAndroidClient(context.device);
    logger.info(
      `[RunnerReadiness] Re-resolved closed CtrlProxy client for ${context.device.deviceId}`,
    );
    hold.release = replacement.beginReadinessHold?.();
    if (replacement.isClosed?.()) {
      await this.failUnresponsiveClient(context, replacement, "runner-connect", attempts, false);
    }
    return replacement;
  }

  private async rebindUnhealthyAndroidAccessibilityService(
    context: ReadinessAttemptContext,
    manager: ReadinessAndroidManager | undefined,
    attempts: number,
    client: ReadinessClient,
  ): Promise<void> {
    if (
      context.device.platform !== "android" ||
      !manager?.rebindIfUnhealthy ||
      // A rebind that already ran can briefly leave dumpsys reporting an
      // unbound service while its new process starts. Repeating force-stop in
      // that interval prevents the WebSocket from staying up long enough to
      // connect (Playground run 36326684647).
      context.ctrlProxyAccessibilityRebindAttempted ||
      this.dependencies.timer.now() - context.lastCtrlProxyRebindMs <
        CTRL_PROXY_REBIND_RECOVERY_POLL_MS
    ) {
      return;
    }
    const rebindAttempted = await this.phases.runPhase(
      context,
      "runner-connect",
      attempts,
      async () => {
        try {
          return await manager.rebindIfUnhealthy!();
        } catch (error) {
          if (!(error instanceof CtrlProxyInspectionError)) {
            throw error;
          }
          // Inspection did not mutate settings, so a normal connection attempt remains safe.
          logger.warn(`[CTRL_PROXY] Accessibility rebind inspection unavailable: ${error}`, error);
          return false;
        }
      },
    );
    context.lastCtrlProxyRebindMs = this.dependencies.timer.now();
    context.ctrlProxyAccessibilityRebindAttempted ||= rebindAttempted;
    if (rebindAttempted) {
      // The rebind just changed the endpoint's state; failures recorded
      // before it must not cool down the waitForConnection() dial that
      // follows (issue #7538).
      client.resetConnectionBudget?.();
    }
  }

  /**
   * Android steady-state health failed with the WebSocket still connected
   * (issue #7533). Unlike the disconnected branch above, the framework
   * distinguishes two causes and each needs a different fix, matching the
   * iOS contract in `ensureIosReady`:
   *
   * 1. The accessibility binding itself is crashed or unbound —
   *    `rebindIfUnhealthy()` already checks health internally and no-ops when
   *    it is not, so it is safe to call unconditionally here; it is the same
   *    primitive #7470/#7532 use for the disconnected branch.
   * 2. The binding is healthy but the process still cannot produce a
   *    hierarchy — no amount of re-probing fixes that, so restart the
   *    process the way `forceRestart` does on iOS. At most once per
   *    readiness request, and never against a device `forceRestartProcess`
   *    itself finds offline or missing (see `AndroidCtrlProxyManager`).
   *    Escalation additionally waits out
   *    {@link CTRL_PROXY_POST_REBIND_RESTART_GRACE_MS} since the last
   *    successful rebind and requires
   *    {@link CTRL_PROXY_RESTART_MIN_FAILED_PROBES} failed probes since the
   *    last rebind: a freshly re-bound service on a loaded emulator
   *    can take well over one probe interval to answer, and without both
   *    gates a single slow-but-recovering probe force-stopped the service
   *    that had just been repaired.
   */
  private async recoverConnectedButUnresponsiveAndroid(
    context: ReadinessAttemptContext,
    manager: ReadinessAndroidManager | undefined,
    client: ReadinessClient,
    attempts: number,
  ): Promise<void> {
    if (context.device.platform !== "android" || !manager) {
      return;
    }
    context.failedHealthProbesSinceRecovery++;
    if (
      this.dependencies.timer.now() - context.lastConnectedRecoveryMs <
      CTRL_PROXY_REBIND_RECOVERY_POLL_MS
    ) {
      return;
    }
    const failedProbesSinceRecovery = context.failedHealthProbesSinceRecovery;
    context.lastConnectedRecoveryMs = this.dependencies.timer.now();

    if (manager.rebindIfUnhealthy && !context.ctrlProxyAccessibilityRebindAttempted) {
      const rebindAttempted = await this.phases.runPhase(context, "runner-health", attempts, () =>
        manager.rebindIfUnhealthy!(),
      );
      context.ctrlProxyAccessibilityRebindAttempted ||= rebindAttempted;
      if (rebindAttempted) {
        context.failedHealthProbesSinceRecovery = 0;
        context.lastSuccessfulRebindMs = this.dependencies.timer.now();
        // The rebind just changed the endpoint's state; give the fresh bind a
        // chance to answer before escalating to a full process restart, and
        // do not cool down the health probe that follows (issue #7538).
        client.resetConnectionBudget?.();
        return;
      }
    }

    if (!this.canEscalateToProcessRestart(context, manager, failedProbesSinceRecovery)) {
      return;
    }
    context.ctrlProxyProcessRestartAttempted = true;
    const restarted = await this.phases.runPhase(context, "runner-health", attempts, () =>
      manager.forceRestartProcess!(),
    );
    if (restarted) {
      client.resetConnectionBudget?.();
    }
  }

  /**
   * Whether {@link recoverConnectedButUnresponsiveAndroid} may escalate to a
   * full process restart: at most once per readiness request, only when the
   * manager exposes the primitive, and only once the post-rebind grace period
   * and minimum-failed-probes gates (see the doc above) both clear.
   */
  private canEscalateToProcessRestart(
    context: ReadinessAttemptContext,
    manager: ReadinessAndroidManager,
    failedProbesSinceRecovery: number,
  ): manager is ReadinessAndroidManager & {
    forceRestartProcess: NonNullable<ReadinessAndroidManager["forceRestartProcess"]>;
  } {
    if (context.ctrlProxyProcessRestartAttempted || !manager.forceRestartProcess) {
      return false;
    }
    if (failedProbesSinceRecovery < CTRL_PROXY_RESTART_MIN_FAILED_PROBES) {
      return false;
    }
    return (
      this.dependencies.timer.now() - context.lastSuccessfulRebindMs >=
      CTRL_PROXY_POST_REBIND_RESTART_GRACE_MS
    );
  }

  /**
   * Report why `waitForResponsiveClient` gave up. A known connect-attempt
   * failure that is SPECIFICALLY the CtrlProxy forwarding-lease conflict (a
   * stale/orphaned AutoMobile process still owning forwarding for this
   * device) is the actual, actionable cause — surface IT instead of the
   * generic device-blaming message below, which points a caller at rebooting
   * a device that was never the problem (issue #6260). Every OTHER stored
   * connect failure (ECONNREFUSED, a timeout, ...) must NOT take this
   * branch: it would replace the existing Android diagnostics
   * (primaryUserStartState, deviceLock) with raw transport text for a runner
   * that is merely locked or still booting (PRRT ft82e).
   */
  private async failUnresponsiveClient(
    context: ReadinessAttemptContext,
    client: ReadinessClient,
    phase: RunnerReadinessPhase,
    attempts: number,
    deadlineExhausted = true,
  ): Promise<never> {
    const isForwardingLeaseConflict =
      phase === "runner-connect" &&
      (client.isLastConnectionFailureForwardingLeaseConflict?.() ?? false);
    if (isForwardingLeaseConflict) {
      const lastConnectionFailure = client.getLastConnectionFailureMessage?.();
      if (lastConnectionFailure) {
        this.phases.fail(context, phase, attempts, lastConnectionFailure);
      }
    }
    if (phase === "runner-connect") {
      this.failForwardUnavailableClient(context, client, attempts, deadlineExhausted);
    }
    const diagnostic =
      phase === "runner-connect"
        ? await this.runnerConnectFailureDiagnostic(context)
        : await this.runnerHealthFailureDiagnostic(context, phase);
    this.phases.fail(
      context,
      phase,
      attempts,
      `${this.unresponsiveClientRecoveryNote(context, phase)}${diagnostic}`,
      { deadlineExhausted: true },
    );
  }

  private failForwardUnavailableClient(
    context: ReadinessAttemptContext,
    client: ReadinessClient,
    attempts: number,
    deadlineExhausted: boolean,
  ): void {
    const cause =
      client.getForwardFailureCause?.() ??
      (client.isClosed?.()
        ? `CtrlProxy client for ${context.device.deviceId} is closed; adb forward unavailable`
        : undefined);
    if (cause) {
      this.phases.fail(context, "runner-connect", attempts, cause, {
        deadlineExhausted,
        failureKind: "ctrlproxy_forward_unavailable",
      });
    }
  }

  /**
   * Describe which recovery step (if any) `waitForResponsiveClient` already
   * tried, so a final failure diagnostic says whether the runner was merely
   * slow or a recovery attempt (rebind or full restart, #7470/#7533) already
   * ran and still did not restore it.
   */
  private unresponsiveClientRecoveryNote(
    context: ReadinessAttemptContext,
    phase: RunnerReadinessPhase,
  ): string {
    if (phase === "runner-connect" && context.ctrlProxyAccessibilityRebindAttempted) {
      return "CtrlProxy accessibility service was crashed or unbound; rebind attempted, but the runner did not become responsive before the readiness deadline";
    }
    if (context.ctrlProxyProcessRestartAttempted) {
      return "CtrlProxy accessibility service was bound but unresponsive; process restart attempted, but the runner did not become responsive before the readiness deadline";
    }
    return "runner did not become responsive before the readiness deadline";
  }

  private async runnerConnectFailureDiagnostic(context: ReadinessAttemptContext): Promise<string> {
    const getDiagnostic = this.dependencies.getAndroidRunnerConnectDiagnostic;
    if (context.device.platform !== "android" || !getDiagnostic) {
      return "";
    }

    const diagnostic = await this.collectBoundedAndroidDiagnostic(
      context,
      getDiagnostic,
      "runner-connect",
    );
    if (!diagnostic) {
      return "";
    }
    const details = [
      diagnostic.primaryUserStartState
        ? `primaryUserStartState=${diagnostic.primaryUserStartState}`
        : undefined,
      diagnostic.deviceLock
        ? `deviceLock=${diagnostic.deviceLock.locked ? "locked" : "unlocked"}`
        : undefined,
    ].filter((detail): detail is string => Boolean(detail));
    return details.length > 0 ? `; ${details.join(" ")}` : "";
  }

  private async runnerHealthFailureDiagnostic(
    context: ReadinessAttemptContext,
    phase: RunnerReadinessPhase,
  ): Promise<string> {
    const getDiagnostic = this.dependencies.getAndroidRunnerHealthDiagnostic;
    if (context.device.platform !== "android" || phase !== "runner-health" || !getDiagnostic) {
      return "";
    }

    const diagnostic = await this.collectBoundedAndroidDiagnostic(
      context,
      getDiagnostic,
      "runner-health",
    );
    if (!diagnostic) {
      return "";
    }
    return (
      `; sys.boot_completed=${diagnostic.sysBootCompleted} adbDevices=${diagnostic.adbDevices} ` +
      `emulatorQemuHealth=${diagnostic.emulatorQemuHealth}`
    );
  }

  private async collectBoundedAndroidDiagnostic<T>(
    context: ReadinessAttemptContext,
    getDiagnostic: (device: BootedDevice, signal: AbortSignal) => Promise<T>,
    phase: "runner-connect" | "runner-health",
  ): Promise<T | undefined> {
    try {
      const controller = new AbortController();
      const signal = context.signal
        ? AbortSignal.any([context.signal, controller.signal])
        : controller.signal;
      const diagnosticPromise = getDiagnostic(context.device, signal);
      // The timeout returns first if an ADB diagnostic command hangs. Its
      // rejection after abort is intentionally observed below.
      void diagnosticPromise.catch((error) => {
        // Supplemental diagnostics may reject after timeout abort; the readiness failure is preserved.
        logger.debug(`Android readiness diagnostic rejection observed: ${errorMessage(error)}`);
      });
      const timedOut = new Error(`${phase} diagnostic timed out`);
      let diagnostic: T | undefined;
      try {
        diagnostic = await raceWithDeadline(diagnosticPromise, {
          timer: this.dependencies.timer,
          timeoutMs: RUNNER_CONNECT_DIAGNOSTIC_TIMEOUT_MS,
          label: `${phase} diagnostic`,
          timeoutError: () => timedOut,
          onTimeout: () => controller.abort(timedOut),
        });
      } catch (error) {
        if (error !== timedOut) {
          throw error;
        }
      }
      if (!diagnostic) {
        return undefined;
      }
      return diagnostic;
    } catch (error) {
      // This supplemental probe must not hide the original readiness timeout.
      logger.debug(`Failed to collect Android ${phase} diagnostic: ${errorMessage(error)}`);
      return undefined;
    }
  }
}
