import type { Kysely } from "kysely";
import { z } from "zod/v4";
import { getDatabase } from "./database";
import type { Database } from "./types";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import type {
  DeviceResourceApplicationRecord,
  SimulatorResourceIdentity,
} from "../models/DeviceResourceReconciliation";
import type { DeviceResourceConfiguration } from "../models/DeviceResourceConfiguration";
import {
  simulatorResourceIdentityKey,
  type DeviceResourceApplicationStore,
} from "../utils/deviceResourceApplicationStore";

const resourcesSchema = z.record(z.string(), z.enum(["enabled", "disabled"]));

/** SQLite-backed store of AutoMobile-applied simulator service overrides. */
export class DeviceResourceApplicationRepository implements DeviceResourceApplicationStore {
  constructor(private readonly db?: Kysely<Database>) {}

  // Resolve lazily so construction never opens the default database.
  private getDb(): Kysely<Database> {
    return this.db ?? getDatabase();
  }

  async get(identity: SimulatorResourceIdentity): Promise<DeviceResourceApplicationRecord | null> {
    const row = await this.getDb()
      .selectFrom("device_resource_applications")
      .selectAll()
      .where("identity_key", "=", simulatorResourceIdentityKey(identity))
      .executeTakeFirst();
    if (!row) {
      return null;
    }
    let resources: DeviceResourceConfiguration;
    try {
      // Keys were written from the typed catalog; values are validated here.
      resources = resourcesSchema.parse(JSON.parse(row.resources_json));
    } catch (error) {
      logger.warn(
        `Ignoring unreadable device resource record for ${identity.udid}: ${errorMessage(error)}`,
        error,
      );
      return null;
    }
    return {
      identity,
      resources,
      profileFingerprint: row.profile_fingerprint,
      updatedAtMs: row.updated_at_ms,
    };
  }

  async put(record: DeviceResourceApplicationRecord): Promise<void> {
    const values = {
      identity_key: simulatorResourceIdentityKey(record.identity),
      udid: record.identity.udid,
      runtime_id: record.identity.runtimeId,
      device_type_id: record.identity.deviceTypeId,
      resources_json: JSON.stringify(record.resources),
      profile_fingerprint: record.profileFingerprint,
      updated_at_ms: record.updatedAtMs,
    };
    await this.getDb()
      .insertInto("device_resource_applications")
      .values(values)
      .onConflict((conflict) =>
        conflict.column("identity_key").doUpdateSet({
          resources_json: values.resources_json,
          profile_fingerprint: values.profile_fingerprint,
          updated_at_ms: values.updated_at_ms,
        }),
      )
      .execute();
  }

  async delete(identity: SimulatorResourceIdentity): Promise<void> {
    await this.getDb()
      .deleteFrom("device_resource_applications")
      .where("identity_key", "=", simulatorResourceIdentityKey(identity))
      .execute();
  }
}
