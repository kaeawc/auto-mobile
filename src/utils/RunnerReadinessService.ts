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

const READINESS_RETRY_DELAY_MS = 250;
const READINESS_PROBE_TIMEOUT_MS = 2_000;
const MAX_DIAGNOSTIC_LENGTH = 4_000;
const ABORT_SETTLEMENT_GRACE_MS = 1_000;

type RunnerReadinessPhase =
  | "package-compatibility"
  | "runner-setup"
  | "runner-connect"
  | "runner-health";

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
  readinessDeadlineMs: number;
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
    const readinessDeadlineMs = Math.min(
      request.totalDeadlineMs,
      this.dependencies.timer.now() + request.readinessTimeoutMs,
    );
    const context: ReadinessAttemptContext = { ...request, readinessDeadlineMs };
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
    if (this.remaining(context) <= 0) {
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
          this.remaining(context),
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
      return;
    }

    if (installed && enabled) {
      manager.resetSetupState();
    }
    await this.setupAndroidRunner(context, manager);
    await this.waitForResponsiveClient(context, client);
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
      return;
    }
    if (!enabled) {
      await this.runPhase(context, "runner-setup", 1, () => manager.enable());
    }
    await this.waitForResponsiveClient(context, client);
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
    }

    if (context.skipCtrlProxyDownload) {
      await this.ensureIosReadyWithoutDownloads(context, manager, client);
      return;
    }

    const setup = await this.runPhase(context, "runner-setup", 1, (signal) =>
      manager.setup(false, context.perf, signal, this.remaining(context)),
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
        minimumHealthPollDurationMs: this.remaining(context),
      }),
    );
    await this.waitForResponsiveClient(context, client);
  }

  private async waitForResponsiveClient(
    context: ReadinessAttemptContext,
    client: ReadinessClient,
  ): Promise<void> {
    let attempts = 0;
    let connected = client.isConnected();
    let phase: RunnerReadinessPhase = connected ? "runner-health" : "runner-connect";
    while (this.remaining(context) > 0) {
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

      const remaining = this.remaining(context);
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
    if (this.remaining(context) <= 0) {
      this.fail(context, phase, attempts, "readiness budget exhausted before phase started");
    }
    const remainingMs = this.remaining(context);
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
    return Math.max(1, Math.min(READINESS_PROBE_TIMEOUT_MS, this.remaining(context)));
  }

  private remaining(context: ReadinessAttemptContext): number {
    return Math.max(0, context.readinessDeadlineMs - this.dependencies.timer.now());
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
    throw new ActionableError(
      `startDevice automation runner readiness failed: ${mapping} phase=${phase} ` +
        `attempts=${attempts} remainingBudgetMs=${this.remaining(context)}: ${normalizeDiagnostic(detail)}`,
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
