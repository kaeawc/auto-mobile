import { sql, type Kysely } from "kysely";
import type { Platform } from "../../../models";
import type { DeviceClaim, DeviceClaimKind, DeviceClaims } from "../../deviceClaims";

export interface DeviceClaimTables {
  device_claims: {
    platform: string;
    device_id: string;
    kind: string;
    daemon_session_id: string | null;
    pid: number;
    owner_token: string;
    process_generation_token: string | null;
    session_uuid: string | null;
    metadata: string | null;
    claimed_at_ms: number;
    updated_at_ms: number;
  };
}

export class SqliteDeviceClaims implements DeviceClaims {
  constructor(
    private readonly db: Kysely<DeviceClaimTables>,
    private readonly write: <T>(
      operation: (db: Kysely<DeviceClaimTables>) => Promise<T>,
    ) => Promise<T> = (operation) => operation(db),
  ) {}

  async upsert(claim: DeviceClaim): Promise<void> {
    const row = toRow(claim);
    await this.write((db) =>
      db
        .insertInto("device_claims")
        .values(row)
        .onConflict((conflict) =>
          conflict
            .columns(["platform", "device_id"])
            .doUpdateSet({
              ...row,
              // Re-claiming by the same owner keeps when it first claimed.
              claimed_at_ms: sql<number>`CASE WHEN device_claims.pid = excluded.pid
              AND device_claims.owner_token = excluded.owner_token
              THEN device_claims.claimed_at_ms ELSE excluded.claimed_at_ms END`,
            })
            .where("device_claims.updated_at_ms", "<=", row.updated_at_ms),
        )
        .execute(),
    );
  }

  async replaceIf(
    expected: { pid: number; ownerToken: string } | undefined,
    claim: DeviceClaim,
  ): Promise<boolean> {
    const row = toRow(claim);
    return this.write(async (db) => {
      if (!expected) {
        const inserted = await db
          .insertInto("device_claims")
          .values(row)
          .onConflict((conflict) => conflict.columns(["platform", "device_id"]).doNothing())
          .executeTakeFirst();
        return Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0;
      }
      const updated = await db
        .updateTable("device_claims")
        .set(row)
        .where("platform", "=", claim.platform)
        .where("device_id", "=", claim.deviceId)
        .where("pid", "=", expected.pid)
        .where("owner_token", "=", expected.ownerToken)
        .executeTakeFirst();
      return Number(updated.numUpdatedRows) > 0;
    });
  }

  async release(
    platform: Platform,
    deviceId: string,
    owner: { pid: number; ownerToken: string },
  ): Promise<void> {
    await this.write((db) =>
      db
        .deleteFrom("device_claims")
        .where("platform", "=", platform)
        .where("device_id", "=", deviceId)
        .where("pid", "=", owner.pid)
        .where("owner_token", "=", owner.ownerToken)
        .execute(),
    );
  }

  async releaseOwnedBy(owner: { pid: number; ownerToken: string }): Promise<void> {
    await this.write((db) =>
      db
        .deleteFrom("device_claims")
        .where("pid", "=", owner.pid)
        .where("owner_token", "=", owner.ownerToken)
        .execute(),
    );
  }

  async get(platform: Platform, deviceId: string): Promise<DeviceClaim | undefined> {
    const row = await this.db
      .selectFrom("device_claims")
      .selectAll()
      .where("platform", "=", platform)
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    return row ? toClaim(row) : undefined;
  }

  async list(): Promise<DeviceClaim[]> {
    const rows = await this.db
      .selectFrom("device_claims")
      .selectAll()
      .orderBy("platform")
      .orderBy("device_id")
      .execute();
    return rows.map(toClaim);
  }
}

function toRow(claim: DeviceClaim): DeviceClaimTables["device_claims"] {
  return {
    platform: claim.platform,
    device_id: claim.deviceId,
    kind: claim.kind,
    daemon_session_id: claim.daemonSessionId ?? null,
    pid: claim.pid,
    owner_token: claim.ownerToken,
    process_generation_token: claim.processGenerationToken ?? null,
    session_uuid: claim.sessionUuid ?? null,
    metadata: claim.metadata ?? null,
    claimed_at_ms: claim.claimedAtMs,
    updated_at_ms: claim.updatedAtMs,
  };
}

function toClaim(row: DeviceClaimTables["device_claims"]): DeviceClaim {
  return {
    platform: row.platform as Platform,
    deviceId: row.device_id,
    kind: row.kind as DeviceClaimKind,
    ...(row.daemon_session_id === null ? {} : { daemonSessionId: row.daemon_session_id }),
    pid: row.pid,
    ownerToken: row.owner_token,
    ...(row.process_generation_token === null
      ? {}
      : { processGenerationToken: row.process_generation_token }),
    ...(row.session_uuid === null ? {} : { sessionUuid: row.session_uuid }),
    ...(row.metadata === null ? {} : { metadata: row.metadata }),
    claimedAtMs: row.claimed_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}
