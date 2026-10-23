import { sql, type Generated, type Kysely } from "kysely";
import type { Timer } from "../../../utils/SystemTimer";
import {
  assertDeviceMutationScope as assertScope,
  deviceBaselineSchema,
  mutationValueSchema,
  type DeviceBaseline,
  type DeviceIncarnationScope,
  type DeviceMutationEntry,
  type DeviceMutationInput,
  type DeviceMutationJournal,
  type DeviceMutationScope,
} from "./types";

export interface DeviceMutationTables {
  device_mutation_journal: {
    sequence: Generated<number>;
    session_uuid: string;
    device_id: string;
    incarnation: string;
    kind: string;
    mutation_key: string;
    prior_value_json: string;
    applied_at_ms: number;
    tool_name: string;
  };
  device_mutation_baselines: {
    device_id: string;
    incarnation: string;
    baseline_json: string;
    captured_at_ms: number;
  };
}

export class SqliteDeviceMutationJournal implements DeviceMutationJournal {
  constructor(
    private readonly db: Kysely<DeviceMutationTables>,
    private readonly timer: Pick<Timer, "now">,
  ) {}

  async record(scope: DeviceMutationScope, mutation: DeviceMutationInput): Promise<void> {
    assertScope(scope, scope.sessionUuid);
    await this.db
      .insertInto("device_mutation_journal")
      .values({
        session_uuid: scope.sessionUuid,
        device_id: scope.deviceId,
        incarnation: scope.incarnation,
        kind: mutation.kind,
        mutation_key: mutation.key,
        prior_value_json: JSON.stringify(mutationValueSchema.parse(mutation.priorValue)),
        applied_at_ms: this.timer.now(),
        tool_name: mutation.toolName,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["session_uuid", "device_id", "incarnation", "kind", "mutation_key"])
          .doNothing(),
      )
      .execute();
  }

  list(scope: DeviceMutationScope): Promise<readonly DeviceMutationEntry[]> {
    return this.listIncarnations(scope, "=");
  }

  listStrayIncarnations(scope: DeviceMutationScope): Promise<readonly DeviceMutationEntry[]> {
    return this.listIncarnations(scope, "!=");
  }

  private async listIncarnations(
    scope: DeviceMutationScope,
    comparison: "=" | "!=",
  ): Promise<readonly DeviceMutationEntry[]> {
    assertScope(scope, scope.sessionUuid);
    const rows = await this.db
      .selectFrom("device_mutation_journal")
      .selectAll()
      .where("session_uuid", "=", scope.sessionUuid)
      .where("device_id", "=", scope.deviceId)
      .where("incarnation", comparison, scope.incarnation)
      .orderBy("sequence", "asc")
      .execute();
    return rows.map((row) => ({
      sequence: row.sequence,
      kind: row.kind,
      key: row.mutation_key,
      priorValue: mutationValueSchema.parse(JSON.parse(row.prior_value_json)),
      appliedAt: row.applied_at_ms,
      toolName: row.tool_name,
    }));
  }

  async deleteSession(scope: DeviceMutationScope): Promise<void> {
    assertScope(scope, scope.sessionUuid);
    await this.db
      .deleteFrom("device_mutation_journal")
      .where("session_uuid", "=", scope.sessionUuid)
      .where("device_id", "=", scope.deviceId)
      .where("incarnation", "=", scope.incarnation)
      .execute();
  }

  async captureBaseline(scope: DeviceIncarnationScope, baseline: DeviceBaseline): Promise<void> {
    assertScope(scope);
    await this.db
      .insertInto("device_mutation_baselines")
      .values({
        device_id: scope.deviceId,
        incarnation: scope.incarnation,
        baseline_json: JSON.stringify(deviceBaselineSchema.parse(baseline)),
        captured_at_ms: this.timer.now(),
      })
      .onConflict((conflict) => conflict.columns(["device_id", "incarnation"]).doNothing())
      .execute();
  }

  async getBaseline(scope: DeviceIncarnationScope): Promise<DeviceBaseline | null> {
    assertScope(scope);
    const row = await this.db
      .selectFrom("device_mutation_baselines")
      .select("baseline_json")
      .where("device_id", "=", scope.deviceId)
      .where("incarnation", "=", scope.incarnation)
      .executeTakeFirst();
    return row ? deviceBaselineSchema.parse(JSON.parse(row.baseline_json)) : null;
  }

  async deleteResource(resourceId: string): Promise<void> {
    assertScope({ deviceId: resourceId, incarnation: resourceId });
    const matches = sql<boolean>`incarnation = ${resourceId} OR CASE WHEN json_valid(incarnation) THEN json_extract(incarnation, '$[0]') = ${resourceId} ELSE 0 END`;
    await this.db.transaction().execute(async (transaction) => {
      await transaction.deleteFrom("device_mutation_journal").where(matches).execute();
      await transaction.deleteFrom("device_mutation_baselines").where(matches).execute();
    });
  }
}
