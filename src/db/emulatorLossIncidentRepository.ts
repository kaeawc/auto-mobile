import type { Kysely } from "kysely";
import { getDatabase } from "./database";
import type { Database } from "./types";
import {
  DEFAULT_MAX_RETAINED_EMULATOR_LOSS_INCIDENTS,
  type EmulatorLossIncident,
  type EmulatorLossIncidentStore,
  type EmulatorLossRecoveryAttempt,
  type EmulatorLossRecoverySettlement,
  type EmulatorRecoveryOutcome,
  type OpenEmulatorLossIncidentInput,
} from "../daemon/emulatorLossIncident";
import type { IdGenerator } from "../utils/IdGenerator";
import { defaultIdGenerator } from "../utils/IdGenerator";
import type { Timer } from "../utils/SystemTimer";
import { defaultTimer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";

const MAX_UPDATE_ATTEMPTS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIncident(value: unknown): value is EmulatorLossIncident {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.deviceId !== "string") {
    return false;
  }
  return (
    typeof value.observedAtMs === "number" &&
    typeof value.updatedAtMs === "number" &&
    typeof value.detectionPath === "string" &&
    isRecord(value.recovery) &&
    Array.isArray(value.recovery.attempts) &&
    isRecord(value.recovery.policy)
  );
}

function decodeIncident(value: string): EmulatorLossIncident | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isIncident(parsed) ? parsed : undefined;
  } catch (error) {
    logger.warn(`[EmulatorLossIncidentRepository] Invalid stored incident: ${error}`, error);
    return undefined;
  }
}

/**
 * Persists a bounded set of emulator-loss incidents. The DB resolves lazily so
 * unit tests must inject their in-memory Kysely database instead of opening the
 * user's default file-backed store.
 */
export class EmulatorLossIncidentRepository implements EmulatorLossIncidentStore {
  constructor(
    private readonly timer: Timer = defaultTimer,
    private readonly idGenerator: IdGenerator = defaultIdGenerator,
    private readonly maxRetained: number = DEFAULT_MAX_RETAINED_EMULATOR_LOSS_INCIDENTS,
    private readonly database?: Kysely<Database>,
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
      ...(input.session ? { session: { ...input.session } } : {}),
      recovery: {
        policy: { ...input.recoveryPolicy },
        attempts: [],
      },
    };
    await this.getDb().transaction().execute(async (trx) => {
      await trx
        .insertInto("emulator_loss_incidents")
        .values({
          incident_id: incident.id,
          device_id: incident.deviceId,
          observed_at_ms: incident.observedAtMs,
          updated_at_ms: incident.updatedAtMs,
          revision: 0,
          incident_json: JSON.stringify(incident),
        })
        .execute();
      const rows = await trx
        .selectFrom("emulator_loss_incidents")
        .select("incident_id")
        .orderBy("observed_at_ms", "desc")
        .orderBy("id", "desc")
        .execute();
      const excessIds = rows.slice(this.maxRetained).map((row) => row.incident_id);
      if (excessIds.length > 0) {
        await trx
          .deleteFrom("emulator_loss_incidents")
          .where("incident_id", "in", excessIds)
          .execute();
      }
    });
    return incident;
  }

  async recordRecoveryAttempt(
    incidentId: string,
    attempt: EmulatorLossRecoveryAttempt,
  ): Promise<void> {
    await this.update(incidentId, (incident) => {
      incident.recovery.attempts.push({ ...attempt });
    });
  }

  async completeRecovery(
    incidentId: string,
    outcome: EmulatorRecoveryOutcome,
    settlement: EmulatorLossRecoverySettlement = {},
  ): Promise<void> {
    await this.update(incidentId, (incident) => {
      incident.recovery.outcome = outcome;
      incident.replacementDeviceId = settlement.replacementDeviceId;
      if (incident.session && settlement.sessionState) {
        incident.session.state = settlement.sessionState;
      }
    });
  }

  async get(incidentId: string): Promise<EmulatorLossIncident | undefined> {
    const row = await this.getDb()
      .selectFrom("emulator_loss_incidents")
      .select("incident_json")
      .where("incident_id", "=", incidentId)
      .executeTakeFirst();
    return row ? decodeIncident(row.incident_json) : undefined;
  }

  async list(limit: number = this.maxRetained): Promise<EmulatorLossIncident[]> {
    const rows = await this.getDb()
      .selectFrom("emulator_loss_incidents")
      .select("incident_json")
      .orderBy("observed_at_ms", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.flatMap((row) => {
      const incident = decodeIncident(row.incident_json);
      return incident ? [incident] : [];
    });
  }

  private getDb(): Kysely<Database> {
    return this.database ?? getDatabase();
  }

  private async update(
    incidentId: string,
    mutate: (incident: EmulatorLossIncident) => void,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
      const row = await this.getDb()
        .selectFrom("emulator_loss_incidents")
        .select(["incident_json", "revision"])
        .where("incident_id", "=", incidentId)
        .executeTakeFirst();
      if (!row) {
        return;
      }
      const incident = decodeIncident(row.incident_json);
      if (!incident) {
        return;
      }
      mutate(incident);
      incident.updatedAtMs = this.timer.now();
      const result = await this.getDb()
        .updateTable("emulator_loss_incidents")
        .set({
          updated_at_ms: incident.updatedAtMs,
          revision: row.revision + 1,
          incident_json: JSON.stringify(incident),
        })
        .where("incident_id", "=", incidentId)
        .where("revision", "=", row.revision)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) > 0) {
        return;
      }
    }
    throw new Error(`Could not update emulator-loss incident ${incidentId} after concurrent updates`);
  }
}
