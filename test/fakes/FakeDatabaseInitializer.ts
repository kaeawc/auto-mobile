import type { DatabaseInitializer } from "../../src/db/DatabaseInitializer";

/**
 * Fake DatabaseInitializer for daemon startup tests.
 *
 * Configure it to resolve (successful bring-up) or to reject with a specific
 * error (migration/DB-open failure) without touching a real sqlite file.
 */
export class FakeDatabaseInitializer implements DatabaseInitializer {
  initializeCalls = 0;
  private nextError: unknown = null;

  constructor(error?: unknown) {
    this.nextError = error ?? null;
  }

  failWith(error: unknown): void {
    this.nextError = error;
  }

  succeed(): void {
    this.nextError = null;
  }

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
    if (this.nextError !== null) {
      throw this.nextError;
    }
  }
}
