import type { Kysely } from "kysely";
import type { DeviceSnapshotConfig } from "../models";
import type { Database } from "./types";
import { KeyedJsonConfigRepository } from "./keyedJsonConfigRepository";

export class DeviceSnapshotConfigRepository extends KeyedJsonConfigRepository<DeviceSnapshotConfig> {
  constructor(db?: Kysely<Database>) {
    super({
      tableName: "device_snapshot_configs",
      loggerTag: "DeviceSnapshotConfigRepository",
      db,
    });
  }
}
