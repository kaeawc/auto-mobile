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

const READINESS_RETRY_DELAY_MS = 250;
const READINESS_PROBE_TIMEOUT_MS = 2_000;
const MAX_DIAGNOSTIC_LENGTH = 4_000;

export type RunnerReadinessPhase =
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
  isInstalled(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  ensureCompatibleVersion(options?: {
    allowDownloadWhenInstalled?: boolean;
    bypassVersionCheckCache?: boolean;
  }): Promise<AndroidCompatibilityResult>;
  setup(force?: boolean, perf?: PerformanceTracker): Promise<ProxySetupResult>;
  resetSetupState(): void;
}

export interface ReadinessIosManager {
  setup(force?: boolean, perf?: PerformanceTracker): Promise<ProxySetupResult>;
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
  perf?: PerformanceTracker;
}

interface ReadinessAttemptContext extends RunnerReadinessRequest {
  readinessDeadlineMs: number;
}

export class RunnerReadinessService {
  constructor(private readonly dependencies: RunnerReadinessDependencies) {}

  async ensureReady(request: RunnerReadinessRequest): Promise<void> {
    const readinessDeadlineMs = Math.min(
      request.totalDeadlineMs,
      this.dependencies.timer.now() + request.readinessTimeoutMs,
    );
    const context: ReadinessAttemptContext = { ...request, readinessDeadlineMs };
    if (request.device.platform === "android") {
      await this.ensureAndroidReady(context);
      return;
    }
    await this.ensureIosReady(context);
  }

  private async ensureAndroidReady(context: ReadinessAttemptContext): Promise<void> {
    const manager = this.dependencies.getAndroidManager(context.device);
    const client = this.dependencies.getAndroidClient(context.device);
    const compatibility = await this.runPhase(context, "package-compatibility", 1, () =>
      manager.ensureCompatibleVersion({
        allowDownloadWhenInstalled: true,
        bypassVersionCheckCache: false,
      }),
    );
    this.assertAndroidCompatibility(context, compatibility);

    const [installed, enabled] = await this.runPhase(context, "runner-setup", 1, () =>
      Promise.all([manager.isInstalled(), manager.isEnabled()]),
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
    const setup = await this.runPhase(context, "runner-setup", 1, () =>
      manager.setup(false, context.perf),
    );
    if (!setup.success) {
      this.fail(context, "runner-setup", 1, setup.error ?? setup.message);
    }
    const [installed, enabled] = await this.runPhase(context, "runner-setup", 1, () =>
      Promise.all([manager.isInstalled(), manager.isEnabled()]),
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

    const setup = await this.runPhase(context, "runner-setup", 1, () =>
      manager.setup(false, context.perf),
    );
    if (!setup.success) {
      this.fail(context, "runner-setup", 1, setup.error ?? setup.message);
    }
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
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.remaining(context) <= 0) {
      this.fail(context, phase, attempts, "readiness budget exhausted before phase started");
    }
    const remainingMs = this.remaining(context);
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timeoutHandle = this.dependencies.timer.setTimeout(
            () => reject(new Error("readiness phase exceeded the remaining deadline")),
            remainingMs,
          );
        }),
      ]);
    } catch (error) {
      return this.fail(context, phase, attempts, normalizeDiagnostic(error));
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
