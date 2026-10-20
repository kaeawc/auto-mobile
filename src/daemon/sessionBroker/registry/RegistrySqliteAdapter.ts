import { SqliteAdapter } from "kysely";

// SQLite supports transactional DDL. Kysely's default SQLite adapter opts out; here a busy
// migration must roll back its ALTERs AND migration records before a factory retries the open.
// Kept registry-local so the per-daemon database retains its existing migration behavior.
export class RegistrySqliteAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean {
    return true;
  }
}
