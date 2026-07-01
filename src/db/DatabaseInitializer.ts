import { getDatabase, ensureMigrations } from "./database";

/**
 * Brings the singleton database up to a query-ready state: opens the connection
 * and awaits startup migrations. Injected into the daemon so startup DB failure
 * can be exercised with a fake (issue #2784) instead of a real sqlite file.
 */
export interface DatabaseInitializer {
  /**
   * Resolves once the DB is open and migrations have completed successfully.
   * Rejects (with the cached startup-migration error) if migrations failed —
   * this is the fatal signal the daemon relies on at startup.
   */
  initialize(): Promise<void>;
}

export class DefaultDatabaseInitializer implements DatabaseInitializer {
  async initialize(): Promise<void> {
    // getDatabase() constructs the connection and kicks off migrations
    // asynchronously; ensureMigrations() awaits them and rethrows a cached
    // startup-migration failure (see src/db/database.ts).
    getDatabase();
    await ensureMigrations();
  }
}
