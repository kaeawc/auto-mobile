import { SqliteAdapter } from "kysely";
import { BunSqliteDialect } from "../../../db/bunSqliteDialect";
import { RegistrySqliteAdapter } from "./RegistrySqliteAdapter";

export class RegistrySqliteDialect extends BunSqliteDialect {
  override createAdapter(): SqliteAdapter {
    return new RegistrySqliteAdapter();
  }
}
