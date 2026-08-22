import type { BootedDevice } from "../models";
import { ActionableError } from "../models";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { AndroidCtrlProxyManager } from "./CtrlProxyManager";
import { IOSCtrlProxyManager } from "./IOSCtrlProxyManager";
import { checkIosCtrlProxyOverride } from "./iosCtrlProxyOverride";
import { redactAndroidCommandOutput } from "./android-cmdline-tools/redactAndroidCommandOutput";
import { defaultTimer, type Timer } from "./SystemTimer";
import type { PerformanceTracker } from "./PerformanceTracker";
import type { ProxySetupResult } from "./interfaces/ProxyManager";
import { runWithAbortSignal } from "./AbortContext";
import {
  centerOfBounds,
  findSystemUiAnrDialog,
  type SystemUiAnrDialog,
} from "./androidSystemUiAnr";
import type { ViewHierarchyResult } from "../models/ViewHierarchyResult";

const READINESS_RETRY_DELAY_MS = 250;
const READINESS_PROBE_TIMEOUT_MS = 2_000;
const MAX_DIAGNOSTIC_LENGTH = 4_000;
const ABORT_SETTLEMENT_GRACE_MS = 1_000;
const SYSTEM_UI_ANR_RECOVERY_POLL_MS = 1_000;
const SYSTEM_UI_ANR_RECOVERY_HEALTHY_POLLS = 2;
const SYSTEM_UI_ANR_RECOVERY_TIMEOUT_MS = 5_000;

type RunnerReadinessPhase =
  | "package-compatibility"
  | "runner-setup"
  | "runner-connect"
  | "runner-health";

export class RunnerReadinessError extends ActionableError {}

export class SystemUiAnrRecoveryRequiredError extends RunnerReadinessError {}

export interface AndroidCompatibilityResult {
  status:
    | "skipped"
    | "not_installed"
    | "compatible"
    | "upgraded"
    | "installed"
    | "reinstalled"
    | "failed";
  acceptedPreinstalled?: boolean;
  error?: string;
  upgradeError?: string;
  reinstallError?: string;
}

export interface ReadinessAndroidManager {
  isInstalled(signal?: AbortSignal): Promise<boolean>;
  isEnabled(signal?: AbortSignal): Promise<boolean>;
  isVersionCompatible(): Promise<boolean>;
  enable(): Promise<void>;
  ensureCompatibleVersion(
    options?: {
      allowDownloadWhenInstalled?: boolean;
      bypassVersionCheckCache?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<AndroidCompatibilityResult>;
  setup(
    force?: boolean,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<ProxySetupResult>;
  resetSetupState(): void;
}

export interface ReadinessIosManager {
  isInstalled(): Promise<boolean>;
  resetSetupState(): void;
  start(options?: {
    signal?: AbortSignal;
    minimumHealthPollDurationMs?: number;
  }): Promise<void>;
  setup(
    force?: boolean,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
    minimumHealthPollDurationMs?: number,
  ): Promise<ProxySetupResult>;
  getServicePort(): number;
}

export interface ReadinessClient {
  isConnected(): boolean;
  waitForConnection(maxAttempts?: number, delayMs?: number): Promise<boolean>;
  verifyServiceReady(maxAttempts?: number, delayMs?: number, timeoutMs?: number): Promise<boolean>;
  getAccessibilityHierarchy?(
    queryOptions?: undefined,
    perf?: undefined,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<ViewHierarchyResult | null>;
  requestTapCoordinates?(
    x: number,
    y: number,
    duration?: number,
    timeoutMs?: number,
  ): Promise<{ success: boolean; error?: string }>;
}

interface SystemUiAnrReadinessClient {
  getAccessibilityHierarchy: NonNullable<ReadinessClient["getAccessibilityHierarchy"]>;
  requestTapCoordinates: NonNullable<ReadinessClient["requestTapCoordinates"]>;
}

export interface RunnerReadinessDependencies {
  timer: Timer;
  getAndroidManager(device: BootedDevice): ReadinessAndroidManager;
  getAndroidClient(device: BootedDevice): ReadinessClient;
  getIosManager(device: BootedDevice): ReadinessIosManager;
  getIosClient(device: BootedDevice, port: number): ReadinessClient;
  checkIosOverride(): Promise<{ present: boolean; usable: boolean; reason?: string }>;
  awaitIosStartupMaintenance(): Promise<void>;
}

export interface RunnerReadinessRequest {
  device: BootedDevice;
  requestedIdentity: string;
  /** User-visible operation that requires the runner to become responsive. */
  operationName?: string;
  /** Absolute deadline shared with device boot. */
  totalDeadlineMs: number;
  /** Maximum time allocated to runner readiness within the total deadline. */
  readinessTimeoutMs: number;
  skipCtrlProxyDownload?: boolean;
  perf?: PerformanceTracker;
  signal?: AbortSignal;
  onRunnerSetup?: () => void;
}

interface ReadinessAttemptContext extends RunnerReadinessRequest {
  /**
   * Absolute deadline for the steady-state connect/health phases, opened when
   * `waitForResponsiveClient` begins (null until then) so a long cold
   * provisioning does not consume the short health budget. Setup/provision
   * phases are bounded by `totalDeadlineMs` directly (#5376).
   */
  healthDeadlineMs: number | null;
}

type ReadinessRelease = () => void;

interface ReadinessWaiter {
  active: boolean;
  resolve: (release: ReadinessRelease) => void;
  reject: (error: unknown) => void;
  timer: Timer;
  timeoutHandle?: NodeJS.Timeout;
  abortListener?: () => void;
  signal?: AbortSignal;
}

interface ReadinessLock {
  locked: boolean;
  waiters: ReadinessWaiter[];
}

const readinessLocksByDevice = new Map<string, ReadinessLock>();

export class RunnerReadinessService {
  constructor(private readonly dependencies: RunnerReadinessDependencies) {}

  async ensureReady(request: RunnerReadinessRequest): Promise<void> {
    // Setup/provision phases run against `totalDeadlineMs`; the connect/health
    // window is opened later (see `startHealthWindow`) so a cold launch cannot
    // starve it (#5376).
    const context: ReadinessAttemptContext = { ...request, healthDeadlineMs: null };
    const key = `${request.device.platform}:${request.device.deviceId}`;
    const release = await this.acquireReadinessTurn(context, key);
    try {
      await this.ensureReadyUncoordinated(context);
    } finally {
      release();
    }
  }

  private async ensureReadyUncoordinated(context: ReadinessAttemptContext): Promise<void> {
    if (context.device.platform === "android") {
      await this.ensureAndroidReady(context);
      return;
    }
    await this.ensureIosReady(context);
  }

  private async acquireReadinessTurn(
    context: ReadinessAttemptContext,
    key: string,
  ): Promise<ReadinessRelease> {
    if (this.remainingForPhase(context, "runner-setup") <= 0) {
      this.fail(context, "runner-setup", 1, "readiness budget exhausted before setup lock");
    }
    const lock = readinessLocksByDevice.get(key) ?? { locked: false, waiters: [] };
    readinessLocksByDevice.set(key, lock);
    if (!lock.locked) {
      lock.locked = true;
      return this.createReadinessRelease(key, lock);
    }
    try {
      return await new Promise<ReadinessRelease>((resolve, reject) => {
        const waiter: ReadinessWaiter = {
          active: true,
          resolve,
          reject,
          timer: this.dependencies.timer,
          signal: context.signal,
        };
        const abandon = (error: unknown) => {
          if (!waiter.active) {
            return;
          }
          waiter.active = false;
          this.removeReadinessWaiter(lock, waiter);
          this.cleanupReadinessWaiter(waiter);
          reject(error);
        };
        waiter.timeoutHandle = this.dependencies.timer.setTimeout(
          () => abandon(new Error("readiness setup lock exceeded this request's deadline")),
          this.remainingForPhase(context, "runner-setup"),
        );
        waiter.abortListener = () => abandon(context.signal?.reason);
        context.signal?.addEventListener("abort", waiter.abortListener, { once: true });
        lock.waiters.push(waiter);
        if (context.signal?.aborted) {
          waiter.abortListener();
        }
      });
    } catch (error) {
      this.fail(context, "runner-setup", 1, normalizeDiagnostic(error));
    }
  }

  private createReadinessRelease(key: string, lock: ReadinessLock): ReadinessRelease {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      let waiter = lock.waiters.shift();
      while (waiter && !waiter.active) {
        waiter = lock.waiters.shift();
      }
      if (waiter) {
        waiter.active = false;
        this.cleanupReadinessWaiter(waiter);
        waiter.resolve(this.createReadinessRelease(key, lock));
        return;
      }
      lock.locked = false;
      if (readinessLocksByDevice.get(key) === lock) {
        readinessLocksByDevice.delete(key);
      }
    };
  }

  private removeReadinessWaiter(lock: ReadinessLock, waiter: ReadinessWaiter): void {
    const index = lock.waiters.indexOf(waiter);
    if (index >= 0) {
      lock.waiters.splice(index, 1);
    }
  }

  private cleanupReadinessWaiter(waiter: ReadinessWaiter): void {
    if (waiter.timeoutHandle) {
      waiter.timer.clearTimeout(waiter.timeoutHandle);
    }
    if (waiter.abortListener) {
      waiter.signal?.removeEventListener("abort", waiter.abortListener);
    }
  }

  private async ensureAndroidReady(context: ReadinessAttemptContext): Promise<void> {
    const manager = this.dependencies.getAndroidManager(context.device);
    const client = this.dependencies.getAndroidClient(context.device);
    if (context.skipCtrlProxyDownload) {
      await this.ensureAndroidReadyWithoutDownloads(context, manager, client);
      return;
    }
    const compatibility = await this.runPhase(context, "package-compatibility", 1, (signal) =>
      manager.ensureCompatibleVersion(
        {
          allowDownloadWhenInstalled: true,
          bypassVersionCheckCache: false,
        },
        signal,
      ),
    );
    this.assertAndroidCompatibility(context, compatibility);

    const [installed, enabled] = await this.runPhase(context, "runner-setup", 1, (signal) =>
      Promise.all([manager.isInstalled(signal), manager.isEnabled(signal)]),
    );
    if (await this.isResponsiveFastPath(context, client, installed && enabled)) {
      await this.recoverSystemUiAnrIfPresent(context, client);
      return;
    }

    if (installed && enabled) {
      manager.resetSetupState();
    }
    await this.setupAndroidRunner(context, manager);
    await this.waitForResponsiveClient(context, client);
    await this.recoverSystemUiAnrIfPresent(context, client);
  }

  private async ensureAndroidReadyWithoutDownloads(
    context: ReadinessAttemptContext,
    manager: ReadinessAndroidManager,
    client: ReadinessClient,
  ): Promise<void> {
    const [installed, enabled] = await this.runPhase(context, "runner-setup", 1, (signal) =>
      Promise.all([manager.isInstalled(signal), manager.isEnabled(signal)]),
    );
    if (!installed) {
      this.fail(
        context,
        "runner-setup",
        1,
        "CtrlProxy is not installed and runner downloads are disabled",
      );
    }
    const compatible = await this.runPhase(context, "package-compatibility", 1, () =>
      manager.isVersionCompatible(),
    );
    if (!compatible) {
      this.fail(
        context,
        "package-compatibility",
        1,
        "CtrlProxy version mismatch; run without skipCtrlProxyDownload to install a compatible version",
      );
    }
    if (await this.isResponsiveFastPath(context, client, enabled)) {
      await this.recoverSystemUiAnrIfPresent(context, client);
      return;
    }
    if (!enabled) {
      await this.runPhase(context, "runner-setup", 1, () => manager.enable());
    }
    await this.waitForResponsiveClient(context, client);
    await this.recoverSystemUiAnrIfPresent(context, client);
  }

  private async recoverSystemUiAnrIfPresent(
    context: ReadinessAttemptContext,
    client: ReadinessClient,
  ): Promise<void> {
    const anrClient = this.systemUiAnrClient(context, client);
    if (!anrClient) {
      return;
    }

    const recoveryDeadlineMs = Math.min(
      context.healthDeadlineMs ?? context.totalDeadlineMs,
      this.dependencies.timer.now() + SYSTEM_UI_ANR_RECOVERY_TIMEOUT_MS,
    );
    const initialHierarchy = await this.readSystemUiAnrHierarchy(
      context,
      anrClient,
      recoveryDeadlineMs,
    );
    const dialog = findSystemUiAnrDialog(initialHierarchy ?? { hierarchy: {} });
    if (!dialog) {
      return;
    }

    await this.selectSystemUiAnrWait(context, anrClient, dialog.waitBounds, recoveryDeadlineMs);
    await this.waitForSystemUiAnrRecovery(
      context,
      anrClient,
      recoveryDeadlineMs,
      initialHierarchy?.updatedAt,
    );
  }

  private systemUiAnrClient(
    context: ReadinessAttemptContext,
    client: ReadinessClient,
  ): SystemUiAnrReadinessClient | undefined {
    if (
      context.device.platform !== "android" ||
      !client.getAccessibilityHierarchy ||
      !client.requestTapCoordinates
    ) {
      return undefined;
    }
    return {
      getAccessibilityHierarchy: (...args) => client.getAccessibilityHierarchy!(...args),
      requestTapCoordinates: (...args) => client.requestTapCoordinates!(...args),
    };
  }

  private async readSystemUiAnrHierarchy(
    context: ReadinessAttemptContext,
    client: SystemUiAnrReadinessClient,
    recoveryDeadlineMs: number,
    minTimestamp = 0,
    required = false,
  ): Promise<ViewHierarchyResult | null> {
    const timeoutMs = Math.min(
      this.probeTimeout(context),
      this.remainingSystemUiAnrRecoveryBudget(recoveryDeadlineMs),
    );
    if (timeoutMs <= 0) {
      this.throwIfCallerCancelled(context);
      if (!required) {
        return null;
      }
      throw this.systemUiAnrRecoveryRequired(
        context,
        "recovery budget expired before the dialog state could be confirmed",
      );
    }
    try {
      const hierarchy = await this.runPhase(context, "runner-health", 1, async (signal) =>
        await client.getAccessibilityHierarchy(
          undefined,
          undefined,
          true,
          minTimestamp,
          true,
          signal,
          timeoutMs,
        ),
      );
      // The production client can fall back to a cached tree when both its
      // fresh-data wait and synchronous request fail. A required read must not
      // treat that stale tree as confirmation that the dialog cleared.
      const isUnavailable = this.isSystemUiAnrHierarchyUnavailable(hierarchy, minTimestamp);
      if (isUnavailable && required) {
        throw this.systemUiAnrRecoveryRequired(
          context,
          "could not confirm dialog recovery: hierarchy unavailable",
        );
      }
      return isUnavailable ? null : hierarchy;
    } catch (error) {
      if (error instanceof SystemUiAnrRecoveryRequiredError) {
        throw error;
      }
      // Genuine cancellation or device loss aborts the request signal. Treating
      // that as "no dialog" would let startDevice bind a session after the
      // caller has already given up, so propagate it on every probe.
      this.throwIfCallerCancelled(context, error);
      if (!required) {
        return null;
      }
      throw this.systemUiAnrRecoveryRequired(
        context,
        `could not confirm dialog recovery: ${normalizeDiagnostic(error)}`,
      );
    }
  }

  private isSystemUiAnrHierarchyUnavailable(
    hierarchy: ViewHierarchyResult | null,
    minTimestamp: number,
  ): boolean {
    if (hierarchy === null || hierarchy.fresh === false) {
      return true;
    }
    return hierarchy.updatedAt !== undefined && hierarchy.updatedAt < minTimestamp;
  }

  private async selectSystemUiAnrWait(
    context: ReadinessAttemptContext,
    client: SystemUiAnrReadinessClient,
    bounds: SystemUiAnrDialog["waitBounds"],
    recoveryDeadlineMs: number,
  ): Promise<void> {
    const { x, y } = centerOfBounds(bounds);
    try {
      const tap = await this.runPhase(context, "runner-health", 1, async () =>
        await client.requestTapCoordinates(
          x,
          y,
          10,
          Math.min(
            this.probeTimeout(context),
            this.remainingSystemUiAnrRecoveryBudget(recoveryDeadlineMs),
          ),
        ),
      );
      if (!tap.success) {
        throw new Error(tap.error ?? "unknown tap failure");
      }
    } catch (error) {
      this.throwIfCallerCancelled(context, error);
      throw this.systemUiAnrRecoveryRequired(
        context,
        `could not select Wait: ${normalizeDiagnostic(error)}`,
      );
    }
  }

  private async waitForSystemUiAnrRecovery(
    context: ReadinessAttemptContext,
    client: SystemUiAnrReadinessClient,
    recoveryDeadlineMs: number,
    initialUpdatedAt: number | undefined,
  ): Promise<void> {
    let healthyPolls = 0;
    let freshAfter = (initialUpdatedAt ?? 0) + 1;
    while (this.remainingSystemUiAnrRecoveryBudget(recoveryDeadlineMs) > 0) {
      await this.dependencies.timer.sleep(
        Math.min(
          SYSTEM_UI_ANR_RECOVERY_POLL_MS,
          this.remainingSystemUiAnrRecoveryBudget(recoveryDeadlineMs),
        ),
      );
      const hierarchy = await this.readSystemUiAnrHierarchy(
        context,
        client,
        recoveryDeadlineMs,
        freshAfter,
        true,
      );
      freshAfter = Math.max(freshAfter, (hierarchy?.updatedAt ?? 0) + 1);
      if (findSystemUiAnrDialog(hierarchy ?? { hierarchy: {} })) {
        healthyPolls = 0;
        continue;
      }
      healthyPolls++;
      if (healthyPolls >= SYSTEM_UI_ANR_RECOVERY_HEALTHY_POLLS) {
        return;
      }
    }

    throw this.systemUiAnrRecoveryRequired(context, "dialog persisted after selecting Wait");
  }

  private remainingSystemUiAnrRecoveryBudget(recoveryDeadlineMs: number): number {
    return Math.max(0, recoveryDeadlineMs - this.dependencies.timer.now());
  }

  private throwIfCallerCancelled(context: ReadinessAttemptContext, fallback?: unknown): void {
    if (context.signal?.aborted) {
      throw context.signal.reason ?? fallback ?? new Error("System UI ANR recovery cancelled");
    }
  }

  private systemUiAnrRecoveryRequired(
    context: ReadinessAttemptContext,
    detail: string,
  ): SystemUiAnrRecoveryRequiredError {
    return new SystemUiAnrRecoveryRequiredError(this.systemUiAnrDiagnostic(context, detail));
  }

  private systemUiAnrDiagnostic(context: ReadinessAttemptContext, detail: string): string {
    return (
      `System UI ANR recovery required: platform=android requested=[${context.requestedIdentity}] ` +
      `resolved=[${context.device.name} (${context.device.deviceId})]: ${detail}`
    );
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
    this.fail(context, "package-compatibility", 1, details.join("; "));
  }

  private async isResponsiveFastPath(
    context: ReadinessAttemptContext,
    client: ReadinessClient,
    runnerConfigured: boolean,
  ): Promise<boolean> {
    if (!runnerConfigured || !client.isConnected()) {
      return false;
    }
    return this.runPhase(context, "runner-health", 1, () =>
      client.verifyServiceReady(1, 0, this.probeTimeout(context)),
    );
  }

  private async setupAndroidRunner(
    context: ReadinessAttemptContext,
    manager: ReadinessAndroidManager,
  ): Promise<void> {
    const setup = await this.runPhase(context, "runner-setup", 1, (signal) =>
      manager.setup(false, context.perf, signal),
    );
    if (!setup.success) {
      this.fail(context, "runner-setup", 1, setup.error ?? setup.message);
    }
    const [installed, enabled] = await this.runPhase(context, "runner-setup", 1, (signal) =>
      Promise.all([manager.isInstalled(signal), manager.isEnabled(signal)]),
    );
    if (!installed || !enabled) {
      this.fail(
        context,
        "runner-setup",
        1,
        `CtrlProxy state after setup: installed=${installed}, enabled=${enabled}`,
      );
    }
  }

  private async ensureIosReady(context: ReadinessAttemptContext): Promise<void> {
    const override = await this.runPhase(context, "runner-setup", 1, () =>
      this.dependencies.checkIosOverride(),
    );
    if (override.present && !override.usable) {
      this.fail(
        context,
        "runner-setup",
        1,
        `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH / _IPA_PATH is set but unusable: ${override.reason ?? "unknown reason"}`,
      );
    }

    await this.runPhase(context, "runner-setup", 1, () =>
      this.dependencies.awaitIosStartupMaintenance(),
    );
    const manager = this.dependencies.getIosManager(context.device);
    const client = this.dependencies.getIosClient(context.device, manager.getServicePort());
    if (client.isConnected()) {
      const ready = await this.runPhase(context, "runner-health", 1, () =>
        client.verifyServiceReady(1, 0, this.probeTimeout(context)),
      );
      if (ready) {
        return;
      }
      manager.resetSetupState();
    }

    if (context.skipCtrlProxyDownload) {
      await this.ensureIosReadyWithoutDownloads(context, manager, client);
      return;
    }

    const setup = await this.runPhase(context, "runner-setup", 1, (signal) =>
      manager.setup(false, context.perf, signal, this.remainingForPhase(context, "runner-setup")),
    );
    context.onRunnerSetup?.();
    if (!setup.success) {
      this.fail(context, "runner-setup", 1, setup.error ?? setup.message);
    }
    await this.waitForResponsiveClient(context, client);
  }

  private async ensureIosReadyWithoutDownloads(
    context: ReadinessAttemptContext,
    manager: ReadinessIosManager,
    client: ReadinessClient,
  ): Promise<void> {
    const installed = await this.runPhase(context, "runner-setup", 1, () => manager.isInstalled());
    if (!installed) {
      this.fail(
        context,
        "runner-setup",
        1,
        "CtrlProxy iOS runner is not installed and runner downloads are disabled",
      );
    }
    await this.runPhase(context, "runner-setup", 1, (signal) =>
      manager.start({
        signal,
        minimumHealthPollDurationMs: this.remainingForPhase(context, "runner-setup"),
      }),
    );
    await this.waitForResponsiveClient(context, client);
  }

  private async waitForResponsiveClient(
    context: ReadinessAttemptContext,
    client: ReadinessClient,
  ): Promise<void> {
    // Provisioning is done; open the steady-state health window now so a long
    // cold launch above did not consume it (#5376).
    this.startHealthWindow(context);
    let attempts = 0;
    let connected = client.isConnected();
    let phase: RunnerReadinessPhase = connected ? "runner-health" : "runner-connect";
    let lastSystemUiProbeMs = Number.NEGATIVE_INFINITY;
    while (this.remainingForPhase(context, "runner-health") > 0) {
      attempts++;
      connected = client.isConnected();
      if (!connected) {
        phase = "runner-connect";
        connected = await this.runPhase(context, phase, attempts, () =>
          client.waitForConnection(1, 0),
        );
      }
      if (connected) {
        phase = "runner-health";
        const ready = await this.runPhase(context, phase, attempts, () =>
          client.verifyServiceReady(1, 0, this.probeTimeout(context)),
        );
        if (ready) {
          return;
        }
      }
      if (
        context.device.platform === "android" &&
        this.dependencies.timer.now() - lastSystemUiProbeMs >= SYSTEM_UI_ANR_RECOVERY_POLL_MS
      ) {
        lastSystemUiProbeMs = this.dependencies.timer.now();
        await this.recoverSystemUiAnrIfPresent(context, client);
      }

      const remaining = this.remainingForPhase(context, "runner-health");
      if (remaining > 0) {
        await this.dependencies.timer.sleep(Math.min(READINESS_RETRY_DELAY_MS, remaining));
      }
    }
    this.fail(
      context,
      phase,
      attempts,
      "runner did not become responsive before the readiness deadline",
    );
  }

  private async runPhase<T>(
    context: ReadinessAttemptContext,
    phase: RunnerReadinessPhase,
    attempts: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.remainingForPhase(context, phase) <= 0) {
      this.fail(context, phase, attempts, "readiness budget exhausted before phase started");
    }
    const remainingMs = this.remainingForPhase(context, phase);
    const controller = new AbortController();
    const signal = context.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const operationPromise = runWithAbortSignal(signal, () => operation(signal));
    void operationPromise.catch(() => {});
    try {
      return await Promise.race([
        operationPromise,
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = this.dependencies.timer.setTimeout(() => {
            controller.abort(new Error("readiness phase exceeded the remaining deadline"));
            reject(new Error("readiness phase exceeded the remaining deadline"));
          }, remainingMs);
        }),
      ]);
    } catch (error) {
      if (controller.signal.aborted) {
        await this.awaitAbortSettlement(operationPromise);
      }
      this.throwIfCallerCancelled(context, error);
      return this.fail(context, phase, attempts, normalizeDiagnostic(error));
    } finally {
      if (timeoutHandle) {
        this.dependencies.timer.clearTimeout(timeoutHandle);
      }
    }
  }

  private async awaitAbortSettlement(operation: Promise<unknown>): Promise<void> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timeoutHandle = this.dependencies.timer.setTimeout(resolve, ABORT_SETTLEMENT_GRACE_MS);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        this.dependencies.timer.clearTimeout(timeoutHandle);
      }
    }
  }

  private probeTimeout(context: ReadinessAttemptContext): number {
    return Math.max(
      1,
      Math.min(READINESS_PROBE_TIMEOUT_MS, this.remainingForPhase(context, "runner-health")),
    );
  }

  /**
   * Setup/provision phases (a cold CtrlProxy download + `xcodebuild`/install
   * launch) are the ones that legitimately take boot-class time, so they run
   * against `totalDeadlineMs`. Connect/health probes are steady-state and stay
   * fast-fail against the health window (#5376).
   */
  private static isSetupPhase(phase: RunnerReadinessPhase): boolean {
    return phase === "runner-setup" || phase === "package-compatibility";
  }

  private phaseDeadlineMs(context: ReadinessAttemptContext, phase: RunnerReadinessPhase): number {
    if (RunnerReadinessService.isSetupPhase(phase)) {
      return context.totalDeadlineMs;
    }
    // Before the health window opens (fast-path probes run before setup), fall
    // back to the total deadline; those probes self-bound via `probeTimeout`.
    return context.healthDeadlineMs ?? context.totalDeadlineMs;
  }

  private remainingForPhase(
    context: ReadinessAttemptContext,
    phase: RunnerReadinessPhase,
  ): number {
    return Math.max(0, this.phaseDeadlineMs(context, phase) - this.dependencies.timer.now());
  }

  /**
   * Open the steady-state connect/health window once provisioning is done, so a
   * long cold launch does not eat the health budget. Still bounded by the
   * caller's total deadline (#5376).
   */
  private startHealthWindow(context: ReadinessAttemptContext): void {
    context.healthDeadlineMs = Math.min(
      context.totalDeadlineMs,
      this.dependencies.timer.now() + context.readinessTimeoutMs,
    );
  }

  private fail(
    context: ReadinessAttemptContext,
    phase: RunnerReadinessPhase,
    attempts: number,
    detail: string,
  ): never {
    const { device } = context;
    const mapping =
      `platform=${device.platform} requested=[${context.requestedIdentity}] ` +
      `resolved=[${device.name} (${device.deviceId})]`;
    throw new RunnerReadinessError(
      `${context.operationName ?? "startDevice"} automation runner readiness failed: ${mapping} phase=${phase} ` +
        `attempts=${attempts} remainingBudgetMs=${this.remainingForPhase(context, phase)}: ${normalizeDiagnostic(detail)}`,
    );
  }
}

function normalizeDiagnostic(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = redactAndroidCommandOutput(raw);
  if (redacted.length <= MAX_DIAGNOSTIC_LENGTH) {
    return redacted;
  }
  const half = Math.floor((MAX_DIAGNOSTIC_LENGTH - 32) / 2);
  return `${redacted.slice(0, half)}\n...[diagnostic truncated]...\n${redacted.slice(-half)}`;
}

export function createDefaultRunnerReadinessService(
  timer: Timer = defaultTimer,
): RunnerReadinessService {
  return new RunnerReadinessService({
    timer,
    getAndroidManager: (device) => AndroidCtrlProxyManager.getInstance(device),
    getAndroidClient: (device) => AndroidCtrlProxyClient.getInstance(device),
    getIosManager: (device) => IOSCtrlProxyManager.getInstance(device),
    getIosClient: (device, port) => IOSCtrlProxyClient.getInstance(device, port),
    checkIosOverride: checkIosCtrlProxyOverride,
    awaitIosStartupMaintenance: () => IOSCtrlProxyManager.awaitStartupOrphanRunnerReap(),
  });
}
