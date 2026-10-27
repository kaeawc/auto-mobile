import type { FeatureFlagKey } from "../features/featureFlags/FeatureFlagDefinitions";
import { persistedOutputReductionOverrides } from "../features/featureFlags/persistedOutputReductionOverrides";
import { resolveActionsCompactMetadata } from "../utils/outputReductionFlags";
import { startupBenchmark } from "../utils/startupBenchmark";
import type { ServerModules } from "./serverModules";
import type { ParsedArgs } from "./startupContext";

/** The accessibility-audit options a `--accessibility-audit` run was configured with. */
export type AccessibilityAuditConfig = {
  level: string;
  failureMode: string;
  minSeverity: string;
  useBaseline: boolean | undefined;
};

export function buildAccessibilityConfig(args: ParsedArgs): AccessibilityAuditConfig | null {
  if (!args.a11yAuditMode) {
    return null;
  }
  return {
    level: args.a11yLevel || "AA",
    failureMode: args.a11yFailureMode || "report",
    minSeverity: args.a11yMinSeverity || (args.a11yFailureMode === "strict" ? "error" : "warning"),
    useBaseline: args.a11yUseBaseline,
  };
}

type CliFeatureFlagOverride = [
  FeatureFlagKey,
  boolean,
  string,
  (Record<string, unknown> | null | undefined)?,
];

function cliFeatureFlagOverrides(
  args: ParsedArgs,
  accessibilityConfig: AccessibilityAuditConfig | null,
): CliFeatureFlagOverride[] {
  return [
    ["debug", args.debug, "--debug"],
    ["debug-perf", args.debugPerf, "--debug-perf/--ui-perf-debug"],
    ["ui-perf-mode", args.uiPerfMode, "--ui-perf-mode"],
    ["mem-perf-audit", args.memPerfAuditMode, "--mem-perf-audit"],
    ["accessibility-audit", args.a11yAuditMode, "--accessibility-audit", accessibilityConfig],
    ["predictive-ui", args.predictiveUi, "--predictive/--predictive-ui"],
    ["raw-element-search", args.rawElementSearch, "--raw-element-search"],
    ["tool-call-recording", args.toolCallRecording, "--tool-call-recording"],
    ...persistedOutputReductionOverrides(args.outputReduction).map(
      ({ key, label }): CliFeatureFlagOverride => [key, true, label, undefined],
    ),
  ];
}

/**
 * All DB-touching feature-flag startup work: migration-gated initialize() reads AND the
 * CLI-override setFlag() writes. In --daemon-mode this runs inside the circuit breaker so a
 * startup DB failure anywhere here — including a write that fails on a read-only/full DB launched
 * with --debug, --tool-call-recording, --no-navigation-screenshots — funnels through the same
 * classify/record/backoff/rethrow path instead of escaping to main().catch and tight-respawning
 * (issue #2784).
 */
export function createFeatureFlagStartup(
  args: ParsedArgs,
  modules: ServerModules,
  accessibilityConfig: AccessibilityAuditConfig | null,
): () => Promise<void> {
  const { logger, serverConfig } = modules;
  const featureFlagService = modules.FeatureFlagService.getInstance();
  const cliOverrides = cliFeatureFlagOverrides(args, accessibilityConfig);
  return async () => {
    await featureFlagService.initialize();

    for (const [key, enabled, flagLabel, config] of cliOverrides) {
      if (!enabled) {
        continue;
      }
      await featureFlagService.setFlag(key, enabled, config);
      logger.info(`Feature flag ${enabled ? "enabled" : "disabled"} (${flagLabel})`);
    }

    // Resolve local behavior after persistence is loaded; keep the relay tri-state.
    // The CLI/env compact-metadata choice is never persisted (#10377).
    serverConfig.setActionsCompactMetadataEnabled(
      resolveActionsCompactMetadata(
        args.outputReduction.actionsCompactMetadata,
        featureFlagService.isEnabled("actions-compact-metadata"),
      ),
    );

    if (!args.navigationScreenshots) {
      await featureFlagService.setFlag("navigation-screenshots", false);
      logger.info("Navigation screenshots disabled (--no-navigation-screenshots)");
    }
  };
}

/** Opens and migrates the database (daemon) or refuses a second writer (direct mode). */
export async function runDatabasePreflight(
  args: ParsedArgs,
  modules: ServerModules,
  applyFeatureFlagStartup: () => Promise<void>,
): Promise<void> {
  await startupBenchmark.runPhase("databasePreflight", async () => {
    if (args.daemonMode) {
      await modules.guardDatabaseStartup(async () => {
        await new modules.DefaultDatabaseInitializer().initialize();
        await applyFeatureFlagStartup();
      });
      return;
    }
    // Direct mode (--no-proxy/--direct) opens the shared SQLite DB in-process
    // with no cross-process lock. Refuse BEFORE the first DB touch (feature-flag
    // startup opens the DB and runs migrations) if a live daemon already owns
    // the SAME resolved DB file, to avoid two writers on one sqlite file
    // (SQLITE_BUSY stalls, competing migrations, aux-socket bind conflicts).
    // File-scoped, so an isolated AUTOMOBILE_DB_PATH still starts normally. #2795
    // The ordering (guard before the DB touch, only under noProxy) lives behind
    // runDirectModeStartup() so it can be unit-tested with fakes (issue #2871).
    const { runDirectModeStartup } = await import("../daemon/directModeStartup");
    await runDirectModeStartup({
      noProxy: args.noProxy,
      assertDbOwnership: async () => {
        const { assertDirectModeDbOwnership, createDefaultDirectModeGuardDeps } =
          await import("../daemon/directModeGuard");
        assertDirectModeDbOwnership(createDefaultDirectModeGuardDeps());
      },
      applyFeatureFlagStartup,
    });
  });
}
