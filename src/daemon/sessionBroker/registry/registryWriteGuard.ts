import type { Kysely } from "kysely";
import type { BunSqliteHandle } from "../../../db/bunSqliteDialect";
import { BindingRegistrySchemaUnsupportedError } from "../provisioning/refusal";
import {
  assertSupportedRegistrySchema,
  BINDING_REGISTRY_MIGRATIONS,
  readBindingRegistryWriterVersionsSync,
} from "./bindingRegistryMigrations";
import type { BindingRegistryDatabase } from "./bindingRegistryRows";

/** Recheck after BEGIN IMMEDIATE: a peer may have migrated since this handle opened. */
export function createRegistryWriteGuard({
  db,
  sqlite,
  dbPath,
}: {
  db: Kysely<BindingRegistryDatabase>;
  sqlite?: BunSqliteHandle;
  dbPath: string;
}) {
  return <T>(write: (trx: Kysely<BindingRegistryDatabase>) => Promise<T>): Promise<T> => {
    if (sqlite) {
      return db.transaction().execute((trx) => {
        // The factory owns this same physical connection. Probe synchronously after BEGIN
        // so the guard adds no promise hops to ownership release or other write paths.
        const statement = sqlite.prepare("SELECT name FROM kysely_migration ORDER BY name");
        try {
          const unknownMigrations = statement
            .all()
            .map((row) => {
              if (
                typeof row !== "object" ||
                row === null ||
                !("name" in row) ||
                typeof row.name !== "string"
              ) {
                throw new Error("Invalid binding registry migration name");
              }
              return row.name;
            })
            .filter((name) => !Object.hasOwn(BINDING_REGISTRY_MIGRATIONS, name));
          if (unknownMigrations.length > 0) {
            throw new BindingRegistrySchemaUnsupportedError(
              dbPath,
              unknownMigrations,
              readBindingRegistryWriterVersionsSync(trx, sqlite, unknownMigrations),
            );
          }
        } finally {
          statement.finalize();
        }
        return write(trx);
      });
    }
    return db.transaction().execute(async (trx) => {
      await assertSupportedRegistrySchema(trx, dbPath);
      return write(trx);
    });
  };
}
