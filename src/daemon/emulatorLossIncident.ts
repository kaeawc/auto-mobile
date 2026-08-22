import type { DeviceRecoveryPolicy } from "./poolConfig";
import type { IdGenerator } from "../utils/IdGenerator";
import { defaultIdGenerator } from "../utils/IdGenerator";
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";

export const DEFAULT_MAX_RETAINED_EMULATOR_LOSS_INCIDENTS = 50;

export type EmulatorLossDetectionPath =
  | "watched-process-exit"
  | "device-discovery-miss"
  | "adb-transport-failure"
  | "adb-server-reset";

export type EmulatorRecoveryOutcome = "recovered" | "exhausted" | "not-attempted";

export interface EmulatorLossRecoveryAttempt {
  attempt: number;
  outcome: "failed" | "succeeded";
}

export interface EmulatorLossIncident {
  id: string;
  observedAtMs: number;
  updatedAtMs: number;
  deviceId: string;
  avdName?: string;
  detectionPath: EmulatorLossDetectionPath;
  processExit?: {
    code: number | null;
    signal: NodeJS.Signals | null;
  };
  outputTail?: string;
  lastAdbState?: string;
  recovery: {
    policy: DeviceRecoveryPolicy;
    attempts: EmulatorLossRecoveryAttempt[];
    outcome?: EmulatorRecoveryOutcome;
  };
}

export interface OpenEmulatorLossIncidentInput {
  deviceId: string;
  avdName?: string;
  detectionPath: EmulatorLossDetectionPath;
  processExit?: EmulatorLossIncident["processExit"];
  outputTail?: string;
  lastAdbState?: string;
  recoveryPolicy: DeviceRecoveryPolicy;
}

export interface EmulatorLossIncidentStore {
  open(input: OpenEmulatorLossIncidentInput): Promise<EmulatorLossIncident>;
  recordRecoveryAttempt(incidentId: string, attempt: EmulatorLossRecoveryAttempt): Promise<void>;
  completeRecovery(incidentId: string, outcome: EmulatorRecoveryOutcome): Promise<void>;
  get(incidentId: string): Promise<EmulatorLossIncident | undefined>;
  list(limit?: number): Promise<EmulatorLossIncident[]>;
}

export function deviceLossCancellationReason(deviceId: string, incidentId?: string): string {
  return incidentId
    ? `device-disconnected:${deviceId};incident=${incidentId}`
    : `device-disconnected:${deviceId}`;
}

function copyIncident(incident: EmulatorLossIncident): EmulatorLossIncident {
  return {
    ...incident,
    ...(incident.processExit ? { processExit: { ...incident.processExit } } : {}),
    recovery: {
      ...incident.recovery,
      policy: { ...incident.recovery.policy },
      attempts: incident.recovery.attempts.map((attempt) => ({ ...attempt })),
    },
  };
}

/** Bounded in-memory store used by tests and direct-mode callers. */
export class InMemoryEmulatorLossIncidentStore implements EmulatorLossIncidentStore {
  private readonly incidents = new Map<string, EmulatorLossIncident>();

  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly idGenerator: IdGenerator = defaultIdGenerator,
    private readonly maxRetained: number = DEFAULT_MAX_RETAINED_EMULATOR_LOSS_INCIDENTS,
  ) {}

  async open(input: OpenEmulatorLossIncidentInput): Promise<EmulatorLossIncident> {
    const now = this.timer.now();
    const incident: EmulatorLossIncident = {
      id: `emulator-loss-${this.idGenerator.next()}`,
      observedAtMs: now,
      updatedAtMs: now,
      deviceId: input.deviceId,
      ...(input.avdName ? { avdName: input.avdName } : {}),
      detectionPath: input.detectionPath,
      ...(input.processExit ? { processExit: { ...input.processExit } } : {}),
      ...(input.outputTail ? { outputTail: input.outputTail } : {}),
      ...(input.lastAdbState ? { lastAdbState: input.lastAdbState } : {}),
      recovery: {
        policy: { ...input.recoveryPolicy },
        attempts: [],
      },
    };
    this.incidents.set(incident.id, incident);
    this.prune();
    return copyIncident(incident);
  }

  async recordRecoveryAttempt(
    incidentId: string,
    attempt: EmulatorLossRecoveryAttempt,
  ): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      return;
    }
    incident.recovery.attempts.push({ ...attempt });
    incident.updatedAtMs = this.timer.now();
  }

  async completeRecovery(incidentId: string, outcome: EmulatorRecoveryOutcome): Promise<void> {
    const incident = this.incidents.get(incidentId);
    if (!incident) {
      return;
    }
    incident.recovery.outcome = outcome;
    incident.updatedAtMs = this.timer.now();
  }

  async get(incidentId: string): Promise<EmulatorLossIncident | undefined> {
    const incident = this.incidents.get(incidentId);
    return incident ? copyIncident(incident) : undefined;
  }

  async list(limit: number = this.maxRetained): Promise<EmulatorLossIncident[]> {
    // Match EmulatorLossIncidentRepository.list, whose `.limit(0)` returns no
    // rows. `slice(-0)` equals `slice(0)` and would otherwise return everything.
    const incidents = Array.from(this.incidents.values());
    const newest = limit <= 0 ? [] : incidents.slice(-limit);
    return newest.reverse().map(copyIncident);
  }

  private prune(): void {
    while (this.incidents.size > this.maxRetained) {
      const oldest = this.incidents.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.incidents.delete(oldest);
    }
  }
}
