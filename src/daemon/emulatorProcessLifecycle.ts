import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import { consolePortFromSerial } from "../utils/android-cmdline-tools/EmulatorConsoleClient";
import { AndroidCommandOutputStreamRedactor } from "../utils/android-cmdline-tools/redactAndroidCommandOutput";
import { boundedEmulatorOutputTail } from "../utils/android-cmdline-tools/AndroidEmulatorClient";
import type { BootedDevice } from "../models";
import type {
  DeviceAutolockChildProcess as ChildProcess,
  PooledDevice,
  SessionRecoveryPreparation,
} from "./devicePool";
import type { SessionManager } from "./sessionManager";

export interface EmulatorProcessLifecyclePoolPort {
  getTimer(): Timer;
  getStartedDeviceProcesses(): Map<string, ChildProcess>;
  getStartedDeviceProcessOutput(): Map<string, EmulatorProcessOutputTail>;
  getDevices(): Map<string, PooledDevice>;
  getSessionManager(): SessionManager;
  isReservedForShutdown(device: PooledDevice): boolean;
  prepareSessionPreservingRecovery(
    deviceId: string,
    expectedDevice: PooledDevice,
  ): SessionRecoveryPreparation | undefined;
  finishSessionPreservingRecoveryPreparation(
    preparation: SessionRecoveryPreparation | undefined,
  ): void;
  recordEmulatorLossIncident(
    deviceId: string,
    path: "watched-process-exit",
    exit: { code: number | null; signal: NodeJS.Signals | null },
  ): Promise<string | undefined>;
  finishEmulatorLossIncident(
    incidentId: string | undefined,
    outcome: "not-attempted" | "exhausted",
  ): Promise<void>;
  evictMissingPooledDevice(
    device: PooledDevice,
    reason: string,
    attemptDeviceLossRecovery: boolean,
    incidentId: string | undefined,
    incidentCaptureComplete: boolean,
    recoveryPreparation: SessionRecoveryPreparation | undefined,
  ): Promise<void>;
}

/**
 * A process can emit output after readiness. Capture its redacted bounded tail
 * so a later unexpected exit has the same useful evidence as an early launch
 * failure without retaining unbounded process output.
 */
export class EmulatorProcessOutputTail {
  private output = "";
  private readonly stdoutRedactor = new AndroidCommandOutputStreamRedactor();
  private readonly stderrRedactor = new AndroidCommandOutputStreamRedactor();
  private readonly streamsClosed: Promise<void>;

  constructor(
    childProcess: ChildProcess,
    private readonly timer: Timer,
  ) {
    const hasStreams =
      (childProcess.stdout !== null && childProcess.stdout !== undefined) ||
      (childProcess.stderr !== null && childProcess.stderr !== undefined);
    this.streamsClosed = hasStreams
      ? new Promise((resolve) => childProcess.once("close", resolve))
      : Promise.resolve();
    childProcess.stdout?.on("data", (value) => this.append(value, this.stdoutRedactor));
    childProcess.stderr?.on("data", (value) => this.append(value, this.stderrRedactor));
  }

  snapshot(): string | undefined {
    const output = boundedEmulatorOutputTail(
      this.output + this.stdoutRedactor.snapshot() + this.stderrRedactor.snapshot(),
    );
    return output.length > 0 ? output : undefined;
  }

  async finalize(): Promise<string | undefined> {
    await this.waitForStreamClose();
    this.output = boundedEmulatorOutputTail(
      this.output + this.stdoutRedactor.flush() + this.stderrRedactor.flush(),
    );
    return this.output.length > 0 ? this.output : undefined;
  }

  private append(value: unknown, redactor: AndroidCommandOutputStreamRedactor): void {
    const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString() : "";
    if (!text) {
      return;
    }
    this.output = boundedEmulatorOutputTail(this.output + redactor.append(text));
  }

  private async waitForStreamClose(): Promise<void> {
    const timedOut = Symbol("stream-close-timeout");
    try {
      await raceWithDeadline(this.streamsClosed, {
        timer: this.timer,
        timeoutMs: 1_000,
        label: "Emulator output streams",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
    }
  }
}

// Diagnostic sharing must not hold another handler's dead-device cleanup indefinitely.
const SHARED_PROCESS_EXIT_INCIDENT_WAIT_MS = 1_000;

interface PendingProcessExitIncident {
  incident: Promise<string | undefined>;
  waitWarningLogged: boolean;
}

/** Tracks started emulator processes and responds to their exits against live pool state. */
export class EmulatorProcessLifecycle {
  // Share through the recording handler's entire eviction/recovery pass, not just the write.
  private readonly processExitIncidents = new WeakMap<ChildProcess, PendingProcessExitIncident>();

  constructor(private readonly pool: EmulatorProcessLifecyclePoolPort) {}

  async stopTrackedEmulatorProcess(
    deviceId: string,
    retainLeaseUntil?: (settlement: Promise<unknown>) => void,
  ): Promise<void> {
    const childProcess = this.pool.getStartedDeviceProcesses().get(deviceId);
    await this.stopEmulatorProcess(childProcess, retainLeaseUntil);
    this.pool.getStartedDeviceProcesses().delete(deviceId);
    this.pool.getStartedDeviceProcessOutput().delete(deviceId);
  }

  async stopEmulatorProcess(
    childProcess: ChildProcess | null | undefined,
    retainLeaseUntil?: (settlement: Promise<unknown>) => void,
  ): Promise<void> {
    if (!childProcess || typeof childProcess.kill !== "function") {
      return;
    }

    const exitCode = (childProcess as { exitCode?: number | null }).exitCode;
    if (exitCode === undefined) {
      childProcess.kill();
      return;
    }
    const signalCode = (childProcess as { signalCode?: NodeJS.Signals | null }).signalCode;
    if (exitCode !== null || (signalCode !== null && signalCode !== undefined)) {
      return;
    }

    const exited = new Promise<void>((resolve) => {
      childProcess.once("exit", () => resolve());
    });
    await this.terminateEmulatorProcess(childProcess, exited, retainLeaseUntil);
  }

  private async terminateEmulatorProcess(
    childProcess: ChildProcess,
    exited: Promise<void>,
    retainLeaseUntil?: (settlement: Promise<unknown>) => void,
  ): Promise<void> {
    try {
      childProcess.kill("SIGTERM");
      if (await this.waitForTrackedProcessExit(exited, 1_000)) {
        return;
      }
      childProcess.kill("SIGKILL");
    } catch (error) {
      retainLeaseUntil?.(exited);
      throw error;
    }
    if (!(await this.waitForTrackedProcessExit(exited, 1_000))) {
      retainLeaseUntil?.(exited);
      throw new Error(
        `emulator process ${childProcess.pid ?? "unknown"} did not exit after SIGKILL`,
      );
    }
  }

  private async waitForTrackedProcessExit(
    exited: Promise<void>,
    timeoutMs: number,
  ): Promise<boolean> {
    const timedOut = Symbol("process-exit-timeout");
    try {
      await raceWithDeadline(exited, {
        timer: this.pool.getTimer(),
        timeoutMs,
        label: "Emulator process exit",
        timeoutError: () => timedOut,
      });
      return true;
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      return false;
    }
  }

  async trackStartedDeviceProcess(
    device: BootedDevice,
    childProcess: ChildProcess | null | undefined,
  ): Promise<void> {
    if (device.platform !== "android" || consolePortFromSerial(device.deviceId) === null) {
      return;
    }
    if (!childProcess || typeof childProcess.once !== "function") {
      return;
    }

    this.pool.getStartedDeviceProcesses().set(device.deviceId, childProcess);
    this.pool
      .getStartedDeviceProcessOutput()
      .set(device.deviceId, new EmulatorProcessOutputTail(childProcess, this.pool.getTimer()));
    let exitHandled = false;
    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exitHandled) {
        return;
      }
      exitHandled = true;
      if (this.pool.getStartedDeviceProcesses().get(device.deviceId) !== childProcess) {
        return;
      }
      void this.evictStartedDeviceAfterProcessExit(
        device.deviceId,
        code,
        signal,
        childProcess,
      ).catch((error) => {
        logger.warn(
          `[DevicePool] Failed to evict ${device.deviceId} after emulator process exit: ${error}`,
          error,
        );
      });
    };
    childProcess.once("exit", handleExit);
    const completedExit = this.getCompletedProcessExit(childProcess);
    if (completedExit) {
      exitHandled = true;
      const pooledDeviceAtExit = this.pool.getDevices().get(device.deviceId);
      if (
        await this.handleCompletedProcessExit(
          device.deviceId,
          completedExit,
          pooledDeviceAtExit,
          childProcess,
        )
      ) {
        return;
      }
      throw new Error(
        `Android emulator ${device.deviceId} exited before process tracking completed ` +
          `(code=${completedExit.code ?? "null"}, signal=${completedExit.signal ?? "none"})`,
      );
    }
  }

  hasStartedDeviceProcess(
    deviceId: string,
    childProcess: ChildProcess | null | undefined,
  ): boolean {
    return (
      childProcess !== null &&
      childProcess !== undefined &&
      this.pool.getStartedDeviceProcesses().get(deviceId) === childProcess
    );
  }

  getCompletedProcessExit(
    childProcess: ChildProcess,
  ): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    const code = (childProcess as { exitCode?: number | null }).exitCode;
    const signal = (childProcess as { signalCode?: NodeJS.Signals | null }).signalCode;
    if (code === undefined || (code === null && (signal === null || signal === undefined))) {
      return undefined;
    }
    return { code, signal: signal ?? null };
  }

  private async handleCompletedProcessExit(
    deviceId: string,
    exit: { code: number | null; signal: NodeJS.Signals | null },
    pooledDeviceAtExit: PooledDevice | undefined,
    childProcess: ChildProcess,
  ): Promise<boolean> {
    await this.evictStartedDeviceAfterProcessExit(deviceId, exit.code, exit.signal, childProcess);
    const replacement = this.pool.getDevices().get(deviceId);
    return Boolean(replacement && replacement !== pooledDeviceAtExit);
  }

  async evictStartedDeviceAfterProcessExit(
    deviceId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    childProcess?: ChildProcess,
  ): Promise<void> {
    const device = this.pool.getDevices().get(deviceId);
    if (!device) {
      return;
    }
    if (this.pool.isReservedForShutdown(device)) {
      // An explicit kill owns this incarnation until it confirms physical exit
      // and retires ownership. Its tracked process exit is expected and must
      // not cancel the initiating request or plan through normal loss cleanup.
      return;
    }

    const assignmentCountAtExit = device.assignmentCount;
    const sessionIdAtExit = device.sessionId;
    const sessionAtExit = sessionIdAtExit
      ? this.pool.getSessionManager().getSession(sessionIdAtExit)
      : null;
    const preparation = this.pool.prepareSessionPreservingRecovery(deviceId, device);
    try {
      await this.withProcessExitIncident(
        deviceId,
        code,
        signal,
        childProcess,
        async (incidentId) => {
          if (
            this.pool.getDevices().get(deviceId) !== device ||
            device.assignmentCount !== assignmentCountAtExit ||
            device.sessionId !== sessionIdAtExit ||
            (sessionAtExit !== null &&
              this.pool.getSessionManager().getSession(sessionAtExit.sessionId) !== sessionAtExit)
          ) {
            await this.pool.finishEmulatorLossIncident(incidentId, "not-attempted");
            return;
          }
          try {
            await this.pool.evictMissingPooledDevice(
              device,
              `emulator process exited after startup (code=${code ?? "null"}, signal=${signal ?? "null"})`,
              true,
              incidentId,
              true,
              preparation,
            );
          } catch (error) {
            await this.finishFailedEvictionIncident(incidentId);
            throw error;
          }
        },
      );
    } finally {
      this.pool.finishSessionPreservingRecoveryPreparation(preparation);
    }
  }

  private async withProcessExitIncident(
    deviceId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    childProcess: ChildProcess | undefined,
    handleIncident: (incidentId: string | undefined) => Promise<void>,
  ): Promise<void> {
    childProcess ??= this.pool.getStartedDeviceProcesses().get(deviceId);
    const existing = childProcess && this.processExitIncidents.get(childProcess);
    const pending =
      existing ?? this.recordProcessExitIncident(deviceId, code, signal, childProcess);
    try {
      const incidentId = existing
        ? await this.waitForSharedProcessExitIncident(deviceId, existing)
        : await pending.incident;
      await handleIncident(incidentId);
    } finally {
      // Only the recorder retires sharing, including failed eviction/settlement.
      if (!existing && childProcess && this.processExitIncidents.get(childProcess) === pending) {
        this.processExitIncidents.delete(childProcess);
      }
    }
  }

  private async waitForSharedProcessExitIncident(
    deviceId: string,
    pending: PendingProcessExitIncident,
  ): Promise<string | undefined> {
    const timedOut = Symbol("shared-incident-write-timeout");
    try {
      return await raceWithDeadline(pending.incident, {
        timer: this.pool.getTimer(),
        timeoutMs: SHARED_PROCESS_EXIT_INCIDENT_WAIT_MS,
        label: "Shared emulator-loss incident write",
        timeoutError: () => timedOut,
      });
    } catch (error) {
      if (error !== timedOut) {
        throw error;
      }
      if (!pending.waitWarningLogged) {
        pending.waitWarningLogged = true;
        logger.warn(
          `[DevicePool] Timed out waiting for shared emulator-loss incident for ${deviceId}; continuing cleanup`,
        );
      }
      return undefined;
    }
  }

  private recordProcessExitIncident(
    deviceId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    childProcess = this.pool.getStartedDeviceProcesses().get(deviceId),
  ): PendingProcessExitIncident {
    // Publish before invoking the store, including synchronous/reentrant fakes.
    // The first recorder owns the session snapshot; later handlers only reuse it.
    const incident = Promise.resolve()
      .then(() =>
        this.pool.recordEmulatorLossIncident(deviceId, "watched-process-exit", { code, signal }),
      )
      .catch((error: unknown) => {
        logger.warn(`[DevicePool] Failed to record emulator-loss incident for ${deviceId}`, error);
        // Persistence is best effort. Keep the typed failure so every handler
        // cleans up without retrying a write that may already have committed.
        return undefined;
      });
    const pending = { incident, waitWarningLogged: false };
    if (childProcess) {
      this.processExitIncidents.set(childProcess, pending);
    }
    return pending;
  }

  private async finishFailedEvictionIncident(incidentId: string | undefined): Promise<void> {
    try {
      await this.pool.finishEmulatorLossIncident(incidentId, "exhausted");
    } catch (settlementError) {
      logger.warn(
        `[DevicePool] Failed to settle emulator-loss incident ${incidentId ?? "unknown"} after eviction failure: ${settlementError}`,
        settlementError,
      );
    }
  }
}
