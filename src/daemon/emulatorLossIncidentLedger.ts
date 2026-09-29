import { consolePortFromSerial } from "../utils/android-cmdline-tools/EmulatorConsoleClient";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { RetryExecutor } from "../utils/retry/RetryExecutor";
import type { PooledDevice, DeviceRecoveryPolicy } from "./devicePool";
import type { Session } from "./sessionManager";
import type {
  EmulatorLossDetectionPath,
  EmulatorLossIncident,
  EmulatorLossIncidentStore,
  EmulatorLossRecoverySettlement,
  EmulatorLossSessionSnapshot,
} from "./emulatorLossIncident";

const EMULATOR_LOSS_INCIDENT_WAIT_TIMEOUT_MS = 120_000;

export interface EmulatorLossIncidentPoolPort {
  getDevice(deviceId: string): PooledDevice | null;
  getRecoveryPolicy(): DeviceRecoveryPolicy;
  getSessionForDevice(deviceId: string): string | null;
  getSession(sessionId: string): Session | null;
  getProcessOutputTail(
    deviceId: string,
  ): { finalize(): Promise<string | undefined>; snapshot(): string | undefined } | undefined;
}

export class EmulatorLossIncidentLedger {
  readonly emulatorLossRecoverySettlements = new Map<string, Promise<void>>();
  readonly emulatorLossRecoveryResolvers = new Map<string, () => void>();

  constructor(
    private readonly pool: EmulatorLossIncidentPoolPort,
    readonly emulatorLossIncidentStore: EmulatorLossIncidentStore,
    private readonly timer: Timer,
    private readonly retryExecutor: RetryExecutor,
  ) {}

  /**
   * Opens a durable postmortem record without allowing diagnostics persistence
   * failure to block the critical device-loss cleanup path.
   */
  async recordEmulatorLossIncident(
    deviceId: string,
    detectionPath: EmulatorLossDetectionPath,
    processExit?: { code: number | null; signal: NodeJS.Signals | null },
    lastAdbState?: string,
  ): Promise<string | undefined> {
    const device = this.pool.getDevice(deviceId);
    if (!device || device.platform !== "android" || consolePortFromSerial(device.id) === null) {
      return undefined;
    }
    try {
      // Capture the tail inside the try so a finalize()/snapshot() rejection
      // degrades to no tail rather than blocking device-loss cleanup.
      const outputTail =
        detectionPath === "watched-process-exit"
          ? await this.pool.getProcessOutputTail(deviceId)?.finalize()
          : this.pool.getProcessOutputTail(deviceId)?.snapshot();
      const incident = await this.emulatorLossIncidentStore.open({
        deviceId,
        ...(device.avdName ? { avdName: device.avdName } : {}),
        detectionPath,
        ...(processExit ? { processExit } : {}),
        ...(outputTail ? { outputTail } : {}),
        ...(lastAdbState ? { lastAdbState } : {}),
        ...this.captureEmulatorLossSessionFields(device),
        recoveryPolicy: this.pool.getRecoveryPolicy(),
      });
      const settlement = Promise.withResolvers<void>();
      this.emulatorLossRecoverySettlements.set(incident.id, settlement.promise);
      this.emulatorLossRecoveryResolvers.set(incident.id, settlement.resolve);
      return incident.id;
    } catch (error) {
      logger.warn(
        `[DevicePool] Failed to record emulator-loss incident for ${deviceId}: ${error}`,
        error,
      );
      return undefined;
    }
  }

  private captureEmulatorLossSession(
    device: PooledDevice,
  ): EmulatorLossSessionSnapshot | undefined {
    const sessionId =
      device.sessionId ??
      device.adbServerResetSessionId ??
      this.pool.getSessionForDevice(device.id);
    const session = sessionId ? this.pool.getSession(sessionId) : null;
    return session
      ? {
          sessionUuid: session.sessionId,
          state: "recovering",
          lastHeartbeatMs: session.lastHeartbeat,
          hasReceivedHeartbeat: session.hasReceivedHeartbeat,
          heartbeatTimeoutMs: session.heartbeatTimeoutMs,
        }
      : undefined;
  }

  private captureEmulatorLossSessionFields(device: PooledDevice): {
    session?: EmulatorLossSessionSnapshot;
  } {
    const session = this.captureEmulatorLossSession(device);
    return session ? { session } : {};
  }

  async recordEmulatorLossRecoveryAttempt(
    incidentId: string | undefined,
    attempt: { attempt: number; outcome: "failed" | "succeeded" },
  ): Promise<void> {
    if (!incidentId) {
      return;
    }
    try {
      await this.emulatorLossIncidentStore.recordRecoveryAttempt(incidentId, attempt);
    } catch (error) {
      logger.warn(
        `[DevicePool] Failed to record emulator-loss recovery attempt for ${incidentId}: ${error}`,
        error,
      );
    }
  }

  async completeEmulatorLossRecovery(
    incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
    releasedSessionState?: "awaiting-device",
  ): Promise<void> {
    if (!incidentId) {
      return;
    }
    try {
      await this.retryExecutor.executeOrThrow(
        async () => {
          const incident = await this.emulatorLossIncidentStore.get(incidentId);
          const settlement = this.buildEmulatorLossRecoverySettlement(
            incident,
            outcome,
            releasedSessionState,
          );
          await this.emulatorLossIncidentStore.completeRecovery(incidentId, outcome, settlement);
          if (!incident?.session) {
            this.settleEmulatorLossIncident(incidentId);
          }
        },
        {
          delays: 0,
          onRetry: (error, attempt) => {
            logger.warn(
              `[DevicePool] Retrying emulator-loss incident ${incidentId} finalization after attempt ${attempt}: ${error}`,
              error,
            );
          },
        },
      );
    } catch (error) {
      logger.warn(
        `[DevicePool] Failed to finalize emulator-loss incident ${incidentId}: ${error}`,
        error,
      );
    }
  }

  buildEmulatorLossRecoverySettlement(
    incident: EmulatorLossIncident | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
    releasedSessionState?: "awaiting-device",
  ): EmulatorLossRecoverySettlement {
    if (!incident?.session) {
      return {};
    }
    const session = this.pool.getSession(incident.session.sessionUuid);
    return {
      ...(session && session.assignedDevice !== incident.deviceId
        ? { replacementDeviceId: session.assignedDevice }
        : {}),
      sessionState: session
        ? outcome === "recovered" || outcome === "not-attempted"
          ? "active"
          : "recovering"
        : (releasedSessionState ?? "released"),
    };
  }

  async waitForEmulatorLossIncident(
    incidentId: string,
    timeoutMs: number = EMULATOR_LOSS_INCIDENT_WAIT_TIMEOUT_MS,
  ): Promise<Awaited<ReturnType<EmulatorLossIncidentStore["get"]>>> {
    const settlement = this.emulatorLossRecoverySettlements.get(incidentId);
    if (settlement && timeoutMs > 0) {
      const timeoutError = new Error("Emulator loss incident wait timed out");
      try {
        await raceWithDeadline(settlement, {
          timer: this.timer,
          timeoutMs,
          label: "Emulator loss incident wait",
          timeoutError: () => timeoutError,
        });
      } catch (error) {
        if (error !== timeoutError) {
          throw error;
        }
      }
    }
    return await this.emulatorLossIncidentStore.get(incidentId);
  }

  settleEmulatorLossIncident(incidentId: string | undefined): void {
    if (!incidentId) {
      return;
    }
    this.emulatorLossRecoveryResolvers.get(incidentId)?.();
    this.emulatorLossRecoveryResolvers.delete(incidentId);
    this.emulatorLossRecoverySettlements.delete(incidentId);
  }

  async finishEmulatorLossIncident(
    incidentId: string | undefined,
    outcome: "recovered" | "exhausted" | "not-attempted",
  ): Promise<void> {
    await this.completeEmulatorLossRecovery(incidentId, outcome);
    this.settleEmulatorLossIncident(incidentId);
  }

  async refreshEmulatorLossRecoverySettlement(
    incidentId: string | undefined,
    fallbackOutcome: "exhausted" | "not-attempted",
  ): Promise<void> {
    if (!incidentId) {
      return;
    }
    const incident = await this.emulatorLossIncidentStore.get(incidentId);
    await this.completeEmulatorLossRecovery(
      incidentId,
      incident?.recovery.outcome ?? fallbackOutcome,
    );
  }
}
