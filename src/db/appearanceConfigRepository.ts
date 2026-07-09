import type { Kysely } from "kysely";
import type { AppearanceConfig } from "../models";
import type { Database } from "./types";
import { KeyedJsonConfigRepository } from "./keyedJsonConfigRepository";

export class AppearanceConfigRepository extends KeyedJsonConfigRepository<AppearanceConfig> {
  constructor(db?: Kysely<Database>) {
    super({
      tableName: "appearance_configs",
      loggerTag: "AppearanceConfigRepository",
      db,
    });
  }
}
