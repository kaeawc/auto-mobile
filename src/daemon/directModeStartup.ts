/**
 * The direct-mode (non-daemon) startup ordering, extracted behind an interface
 * so the invariant can be unit-tested directly instead of only by reading
 * `src/index.ts` (there is no `main()` test harness). Issue #2871 stretch AC.
 *
 * The invariant: under `--no-proxy`/`--direct` the DB-ownership guard MUST run
 * BEFORE the first DB touch. When proxy mode is used (`noProxy` false), the guard
 * is skipped entirely — the daemon owns the DB and the guard doesn't apply.
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
   * CLI-override setFlag() writes. Opens the shared SQLite DB and runs migrations
   * only for direct mode; proxy mode delegates this work to the daemon.
   */
  applyFeatureFlagStartup(): Promise<void>;
}

/**
 * Run the direct-mode startup steps in the required order. Under `--no-proxy`
 * the ownership guard runs before the first DB touch so a second writer on a
 * daemon-owned SQLite file is refused before this process opens it (issue #2795).
 * With an isolated `AUTOMOBILE_DB_PATH` the guard is a no-op and startup proceeds
 * normally. Proxy mode delegates feature-flag initialization to the daemon, so the
 * stdio process never races the daemon (or another process) for the shared DB.
 */
export async function runDirectModeStartup(steps: DirectModeStartupSteps): Promise<void> {
  if (!steps.noProxy) {
    return;
  }

  await steps.assertDbOwnership();
  await steps.applyFeatureFlagStartup();
}
