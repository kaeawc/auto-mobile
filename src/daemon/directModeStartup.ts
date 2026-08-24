/**
 * The direct-mode (non-daemon) startup ordering, extracted behind an interface
 * so the invariant can be unit-tested directly instead of only by reading
 * `src/index.ts` (there is no `main()` test harness). Issue #2871 stretch AC.
 *
 * The invariant: under `--no-proxy`/`--direct` the DB-ownership guard MUST run
 * BEFORE the first DB touch. Proxy mode does not touch the DB at all: the daemon
 * owns feature-flag initialization and reports any startup failure to the proxy.
 */
export interface DirectModeStartupSteps {
  /** True only under `--no-proxy`/`--direct`. */
  noProxy: boolean;
  /**
   * Refuse startup if a live daemon already owns this DB file (see
   * {@link import("./directModeGuard").assertDirectModeDbOwnership}). Invoked
   * ONLY under `noProxy`, and always BEFORE {@link applyFeatureFlagStartup}.
   */
  assertDbOwnership(): Promise<void>;
  /**
   * The first DB touch: migration-gated feature-flag initialize() reads plus the
   * CLI-override setFlag() writes. Opens the shared SQLite DB and runs migrations.
   */
  applyFeatureFlagStartup(): Promise<void>;
}

/**
 * Run the direct-mode startup steps in the required order. Under `--no-proxy`
 * the ownership guard runs before the first DB touch so a second writer on a
 * daemon-owned SQLite file is refused before this process opens it (issue #2795).
 * With an isolated `AUTOMOBILE_DB_PATH` the guard is a no-op and startup proceeds
 * normally. In proxy mode, the daemon owns both the guard and feature-flag work,
 * so this client opens no SQLite connection before its stdio transport is ready.
 */
export async function runDirectModeStartup(steps: DirectModeStartupSteps): Promise<void> {
  if (!steps.noProxy) {
    return;
  }
  await steps.assertDbOwnership();
  await steps.applyFeatureFlagStartup();
}
