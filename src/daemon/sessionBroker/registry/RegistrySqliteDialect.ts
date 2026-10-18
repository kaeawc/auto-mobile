import { RegistrySqliteAdapter } from "./RegistrySqliteAdapter";
import { SqliteAdapter } from "kysely";
import { BunSqliteDialect } from "../../../db/bunSqliteDialect";

export class RegistrySqliteDialect extends BunSqliteDialect {
  override createAdapter(): SqliteAdapter {
    return new RegistrySqliteAdapter();
  }
}
