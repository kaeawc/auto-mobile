import { describe, expect, test } from "bun:test";
import { SafeDaemonManager as DaemonManager } from "../fakes/SafeDaemonManager";
import { parseDaemonArgs } from "../../src/daemon/cli/daemonArgs";
import { daemonCommandOptions } from "../../src/daemon/cli/runDaemonCommand";
import { parseArgs } from "../../src/cli/parseArgs";
import {
  REUSE_CRITICAL_OPTION_KEYS,
  STARTUP_OPTION_DEFICIT_KEYS,
  startupOptionDeficits,
  mergeDaemonOptions,
} from "../../src/daemon/daemonMcpProxy";
import {
  CONNECTION_PRESENTATION_ENV_KEYS,
  CONNECTION_PRESENTATION_OPTION_KEYS,
  daemonProcessEnvironment,
  daemonProcessOptions,
  daemonReuseOptions,
} from "../../src/daemon/daemonOptionScopes";
import {
  OUTPUT_REDUCTION_FLAG_SPECS,
  parseOutputReductionFlags,
  outputReductionFlagsToArgs,
  resolveActionsCompactMetadata,
} from "../../src/utils/outputReductionFlags";
import type { DaemonOptions } from "../../src/daemon/types";

/**
 * Daemon startup-option propagation guards (issue #4344 propagation audit).
 *
 * The relay MCP/CLI process -> spawned daemon is hand-maintained across several
 * lists: `withDaemonOptions` (serialize), `parseDaemonArgs`/`parseArgs` (parse),
 * and `REUSE_CRITICAL_OPTION_KEYS` (reuse/restart). A flag added to `DaemonOptions`
 * but forgotten in one of them is silently dropped — that is exactly how the three
 * `noA11y*` flags never reached a manager-spawned daemon. These tests round-trip
 * the propagation-critical boolean flags through the REAL serializer
 * (`DaemonManager.withDaemonOptions`, not just the `outputReductionFlagsToArgs`
 * sub-helper) so a future drop fails here instead of in the field.
 */

/** Reach the pure private arg-builder without spawning anything. */
function serialize(options: DaemonOptions): string[] {
  const manager = new DaemonManager();
  const built = manager["withDaemonOptions"]({ command: "auto-mobile", args: [] }, options);
  return built.args;
}

/**
 * Boolean DaemonOptions that MUST survive the spawn relay. A new propagating
 * boolean flag should be added here; if it is not serialized+parsed, this fails.
 */
const PROPAGATING_BOOLEAN_FLAGS: (keyof DaemonOptions)[] = [
  // The surviving output-reduction family — the always-on defaults (compact,
  // skeleton, compact-json, observe-scope gates) no longer carry a flag.
  "observeResultIncludeElements",
  "toolResultsNoStructuredContent",
  "actionsDiffObserve",
  "actionsNoObserve",
  "actionsCompactMetadata",
  // Accessibility-service view filters — the flags the audit found dropped.
  "noA11yIncludeNotImportantViews",
  "noA11yReportViewIds",
  "noA11yRetrieveInteractiveWindows",
  // A representative sample of the hand-written relay.
  "predictiveUi",
  "rawElementSearch",
  "mcpRecording",
  "memPerfAudit",
  "noOcclusion",
];

describe("daemon startup-option propagation", () => {
  test("boolean aliases and repeated valued flags preserve parser consumption", () => {
    const parsed = parseDaemonArgs(
      [
        "--ui-perf-debug",
        "--a11y-use-baseline",
        "--predictive",
        "--skip-accessibility-download",
        "--embedded-sdk",
        "--network-mockable",
        "--dismiss-keyboard-after-input",
        "--no-ui-perf-mode",
        "--no-navigation-screenshots",
        "--no-waitfor-polling-overhead",
        "--enable-tool",
        "first",
        "--disable-tool",
        "old",
        "--enable-tool",
        "second",
        "--plan-execution-lock-scope",
        "invalid",
        "--debug",
        "--host",
        "",
        "--strict-port",
        "--tool-output-dir",
        "",
        "--accessibility-audit",
      ],
      {},
    );
    expect(parsed).toMatchObject({
      debugPerf: true,
      accessibilityUseBaseline: true,
      predictiveUi: true,
      skipCtrlProxyDownload: true,
      embeddedSdk: true,
      networkMockable: true,
      dismissKeyboardAfterInput: true,
      noUiPerfMode: true,
      noNavigationScreenshots: true,
      noWaitForPollingOverhead: true,
      enabledTools: ["first", "second"],
      disabledTools: ["old"],
      debug: true,
      strictPort: true,
      accessibilityAudit: true,
    });
    expect(parsed.planExecutionLockScope).toBeUndefined();
    expect(parsed.host).toBeUndefined();
    expect(parsed.toolOutputsDir).toBeUndefined();
  });

  test.each<{ flag: string; field: keyof DaemonOptions; value: string; warning: string }>([
    { flag: "--port", field: "port", value: "abc", warning: "Invalid port: abc" },
    { flag: "--port", field: "port", value: "99999", warning: "Invalid port: 99999" },
    { flag: "--port", field: "port", value: "-5", warning: "Invalid port: -5" },
    { flag: "--video-fps", field: "videoFps", value: "abc", warning: "Invalid video fps: abc" },
    { flag: "--video-fps", field: "videoFps", value: "-5", warning: "Invalid video fps: -5" },
    {
      flag: "--video-target-bitrate-kbps",
      field: "videoTargetBitrateKbps",
      value: "abc",
      warning: "Invalid video target bitrate: abc",
    },
    {
      flag: "--video-max-throughput-mbps",
      field: "videoMaxThroughputMbps",
      value: "0",
      warning: "Invalid video max throughput: 0",
    },
    {
      flag: "--video-archive-size-mb",
      field: "videoMaxArchiveSizeMb",
      value: "Infinity",
      warning: "Invalid video max archive size: Infinity",
    },
  ])("rejects $flag $value with the main CLI warning", ({ flag, field, value, warning }) => {
    const warnings: string[] = [];
    const parsed = parseDaemonArgs(
      [flag, value, "--strict-port"],
      {},
      {
        warn: (message) => warnings.push(message),
      },
    );
    expect(parsed[field]).toBeUndefined();
    expect(parsed.strictPort).toBe(true);
    expect(warnings).toEqual([warning]);
  });

  test.each<{ flag: string; field: keyof DaemonOptions }>([
    { flag: "--port", field: "port" },
    { flag: "--video-target-bitrate-kbps", field: "videoTargetBitrateKbps" },
    { flag: "--video-max-throughput-mbps", field: "videoMaxThroughputMbps" },
    { flag: "--video-fps", field: "videoFps" },
    { flag: "--video-archive-size-mb", field: "videoMaxArchiveSizeMb" },
    { flag: "--video-quality", field: "videoQualityPreset" },
    { flag: "--video-quality-preset", field: "videoQualityPreset" },
    { flag: "--video-format", field: "videoFormat" },
    { flag: "--accessibility-level", field: "accessibilityLevel" },
    { flag: "--a11y-level", field: "accessibilityLevel" },
    { flag: "--accessibility-failure-mode", field: "accessibilityFailureMode" },
    { flag: "--a11y-failure-mode", field: "accessibilityFailureMode" },
    { flag: "--accessibility-min-severity", field: "accessibilityMinSeverity" },
    { flag: "--a11y-min-severity", field: "accessibilityMinSeverity" },
  ])("$flag never consumes a following flag or stores it as a value", ({ flag, field }) => {
    const parsed = parseDaemonArgs([flag, "--strict-port"], {}, { warn: () => {} });
    expect(parsed[field]).toBeUndefined();
    expect(parsed.strictPort).toBe(true);
    expect(parseDaemonArgs([flag], {}, { warn: () => {} })[field]).toBeUndefined();
  });

  test("preserves valid numeric, video and accessibility values", () => {
    const warnings: string[] = [];
    const parsed = parseDaemonArgs(
      [
        "--port",
        "3000",
        "--video-fps",
        "30",
        "--video-target-bitrate-kbps",
        "4000",
        "--video-max-throughput-mbps",
        "2.5",
        "--video-archive-size-mb",
        "12.5",
        "--video-quality",
        "high",
        "--video-format",
        "mp4",
        "--a11y-level",
        "AAA",
        "--a11y-failure-mode",
        "strict",
        "--a11y-min-severity",
        "error",
        "--strict-port",
      ],
      {},
      { warn: (message) => warnings.push(message) },
    );
    expect(parsed).toMatchObject({
      port: 3000,
      videoFps: 30,
      videoTargetBitrateKbps: 4000,
      videoMaxThroughputMbps: 2.5,
      videoMaxArchiveSizeMb: 12.5,
      videoQualityPreset: "high",
      videoFormat: "mp4",
      accessibilityLevel: "AAA",
      accessibilityFailureMode: "strict",
      accessibilityMinSeverity: "error",
      strictPort: true,
    });
    expect(warnings).toEqual([]);
  });

  test("each propagating boolean flag round-trips serialize -> parse", () => {
    for (const field of PROPAGATING_BOOLEAN_FLAGS) {
      const args = serialize({ [field]: true } as DaemonOptions);
      const parsed = parseDaemonArgs(args);
      expect({ field, value: parsed[field] }).toEqual({ field, value: true });
    }
  });

  test("all propagating boolean flags round-trip together (no cross-interference)", () => {
    const allOn = Object.fromEntries(
      PROPAGATING_BOOLEAN_FLAGS.map((f) => [f, true]),
    ) as DaemonOptions;
    const parsed = parseDaemonArgs(serialize(allOn));
    for (const field of PROPAGATING_BOOLEAN_FLAGS) {
      expect({ field, value: parsed[field] }).toEqual({ field, value: true });
    }
  });

  test("the noA11y flags specifically reach a spawned daemon (regression: audit #4344)", () => {
    const args = serialize({
      noA11yIncludeNotImportantViews: true,
      noA11yReportViewIds: true,
      noA11yRetrieveInteractiveWindows: true,
    });
    expect(args).toContain("--no-include-not-important-views");
    expect(args).toContain("--no-report-view-ids");
    expect(args).toContain("--no-retrieve-interactive-windows");
  });

  test("compact metadata false survives the manager arg builder", () => {
    const args = serialize({ actionsCompactMetadata: false });
    expect(args).toContain("--no-actions-compact-metadata");
    expect(parseDaemonArgs(args, {}).actionsCompactMetadata).toBe(false);
  });

  test("no flags -> no propagation args beyond the base launch", () => {
    // A bare options object must not emit any of the propagating flags.
    const args = serialize({});
    for (const field of PROPAGATING_BOOLEAN_FLAGS) {
      const parsed = parseDaemonArgs(args);
      expect(parsed[field]).toBeUndefined();
    }
  });

  test("runner readiness timeout round-trips and the CLI value overrides the environment", () => {
    const args = serialize({ runnerReadinessTimeoutMs: 45_000 });
    expect(args).toContain("--runner-readiness-timeout-ms");
    expect(
      parseDaemonArgs(args, {
        AUTOMOBILE_RUNNER_READINESS_TIMEOUT_MS: "20000",
      }),
    ).toMatchObject({ runnerReadinessTimeoutMs: 45_000 });
  });

  test("accessibility audit options reach both daemon parsers", () => {
    const options: DaemonOptions = {
      accessibilityAudit: true,
      accessibilityLevel: "AAA",
      accessibilityFailureMode: "strict",
      accessibilityMinSeverity: "error",
      accessibilityUseBaseline: true,
    };

    const args = serialize(options);

    expect(args).toEqual(
      expect.arrayContaining([
        "--accessibility-audit",
        "--a11y-level",
        "AAA",
        "--a11y-failure-mode",
        "strict",
        "--a11y-min-severity",
        "error",
        "--a11y-use-baseline",
      ]),
    );
    expect(parseDaemonArgs(args)).toMatchObject(options);
    expect(parseArgs(args)).toMatchObject({
      a11yAuditMode: true,
      a11yLevel: "AAA",
      a11yFailureMode: "strict",
      a11yMinSeverity: "error",
      a11yUseBaseline: true,
    });
  });

  test("a missing runner readiness value does not consume the following flag", () => {
    const parsed = parseDaemonArgs(["--runner-readiness-timeout-ms", "--debug"]);
    expect(parsed.debug).toBe(true);
    expect(parsed.runnerReadinessTimeoutMs).toBeUndefined();
  });

  // Issue #6136: value-taking options used to advance past the next token even
  // when the value was rejected as `--`-prefixed, so `--host --debug` silently
  // started a non-debug daemon. The missing value must be ignored, not the flag
  // that follows it.
  test.each<{ flag: string; field: keyof DaemonOptions }>([
    { flag: "--host", field: "host" },
    { flag: "--plan-execution-lock-scope", field: "planExecutionLockScope" },
    { flag: "--tool-outputs-dir", field: "toolOutputsDir" },
    { flag: "--tool-output-dir", field: "toolOutputsDir" },
    { flag: "--enable-tool", field: "enabledTools" },
  ])("a missing $flag value does not consume the following flag", ({ flag, field }) => {
    // Isolated env: parseDaemonArgs seeds toolOutputsDir from
    // AUTOMOBILE_TOOL_OUTPUTS_DIR, which would make the tool-output rows
    // environment-dependent under process.env.
    const parsed = parseDaemonArgs([flag, "--debug"], {});
    expect(parsed.debug).toBe(true);
    expect(parsed[field]).toBeUndefined();
  });

  test.each<{ args: string[]; expected: Partial<DaemonOptions> }>([
    { args: ["--host", "0.0.0.0"], expected: { host: "0.0.0.0" } },
    {
      args: ["--plan-execution-lock-scope", "session"],
      expected: { planExecutionLockScope: "session" },
    },
    {
      args: ["--tool-outputs-dir", "/tmp/artifacts"],
      expected: { toolOutputsDir: "/tmp/artifacts" },
    },
  ])(
    "a present value for $args is consumed and the next flag still parses",
    ({ args, expected }) => {
      const parsed = parseDaemonArgs([...args, "--debug"], {});
      expect(parsed).toMatchObject({ ...expected, debug: true });
    },
  );

  test("exact tool defaults round-trip through daemon startup arguments", () => {
    const options: DaemonOptions = {
      enabledTools: ["clipboard", "sqlQuery"],
      disabledTools: ["observe"],
    };

    expect(parseDaemonArgs(serialize(options))).toMatchObject(options);
  });

  test("bare daemon commands preserve recorded tool defaults while explicit empties clear them", () => {
    expect(daemonCommandOptions([], {}).enabledTools).toBeUndefined();
    expect(daemonCommandOptions([], {}).disabledTools).toBeUndefined();
    expect(
      daemonCommandOptions([], {
        startupToolDefaults: { enabledTools: [], disabledTools: [] },
      }),
    ).toMatchObject({ enabledTools: [], disabledTools: [] });
  });

  test("daemon command tool defaults are independently optional per side", () => {
    expect(
      daemonCommandOptions([], {
        startupToolDefaults: { enabledTools: ["clipboard"] },
      }),
    ).toMatchObject({ enabledTools: ["clipboard"] });
    expect(
      daemonCommandOptions([], {
        startupToolDefaults: { enabledTools: ["clipboard"] },
      }).disabledTools,
    ).toBeUndefined();

    expect(
      daemonCommandOptions([], {
        startupToolDefaults: { disabledTools: ["observe"] },
      }),
    ).toMatchObject({ disabledTools: ["observe"] });
    expect(
      daemonCommandOptions([], {
        startupToolDefaults: { disabledTools: ["observe"] },
      }).enabledTools,
    ).toBeUndefined();

    expect(
      daemonCommandOptions([], {
        startupToolDefaults: { enabledTools: [] },
      }),
    ).toMatchObject({ enabledTools: [] });
    expect(
      daemonCommandOptions([], {
        startupToolDefaults: { enabledTools: [] },
      }).disabledTools,
    ).toBeUndefined();
  });
});

describe("reuse-critical drift guard", () => {
  test("every process-global output-reduction flag is reuse-critical", () => {
    // A reuse-critical flag forces a preserving daemon restart when a client
    // requests it and the running daemon lacks it — the mechanism that makes the
    // observe-scope flags propagate to an already-running daemon. Spec-driven, so
    // a new output-reduction flag is covered automatically; this pins that.
    for (const spec of OUTPUT_REDUCTION_FLAG_SPECS.filter(
      ({ field }) =>
        field !== "toolResultsNoStructuredContent" && field !== "actionsCompactMetadata",
    )) {
      expect(STARTUP_OPTION_DEFICIT_KEYS).toContain(spec.field);
    }
    expect(REUSE_CRITICAL_OPTION_KEYS).not.toContain("toolResultsNoStructuredContent");
  });

  test("startup tool defaults reach the daemon without becoming reuse-critical", () => {
    expect(CONNECTION_PRESENTATION_OPTION_KEYS).toEqual([
      "enabledTools",
      "disabledTools",
      "toolResultsNoStructuredContent",
      "actionsCompactMetadata",
    ]);
    expect(
      daemonProcessOptions({
        debug: true,
        enabledTools: ["clipboard"],
        disabledTools: ["observe"],
        toolResultsNoStructuredContent: true,
        actionsCompactMetadata: false,
      }),
    ).toEqual({
      debug: true,
      enabledTools: ["clipboard"],
      disabledTools: ["observe"],
    });
    expect(
      daemonReuseOptions({
        debug: true,
        enabledTools: ["clipboard"],
        disabledTools: ["observe"],
        toolResultsNoStructuredContent: true,
        actionsCompactMetadata: false,
      }),
    ).toEqual({ debug: true });
  });

  test("connection presentation environment does not leak into a spawned daemon", () => {
    expect(CONNECTION_PRESENTATION_ENV_KEYS).toEqual([
      "AUTOMOBILE_ENABLED_TOOLS",
      "AUTOMOBILE_DISABLED_TOOLS",
      "AUTOMOBILE_TOOL_RESULTS_NO_STRUCTURED_CONTENT",
      "AUTOMOBILE_ACTIONS_COMPACT_METADATA",
    ]);
    expect(
      daemonProcessEnvironment({
        AUTOMOBILE_ENABLED_TOOLS: "observe",
        AUTOMOBILE_DISABLED_TOOLS: "tapOn",
        AUTOMOBILE_TOOL_RESULTS_NO_STRUCTURED_CONTENT: "1",
        AUTOMOBILE_ACTIONS_COMPACT_METADATA: "0",
        AUTOMOBILE_DEBUG: "1",
      }),
    ).toEqual({ AUTOMOBILE_DEBUG: "1" });
  });
});

// Persistence affects process-local behavior only; proxies never infer a relay preference from it.
const compactPreferenceCases = [false, true].flatMap((negative) =>
  [false, true].flatMap((positive) =>
    ["0", "1", undefined, "false"].flatMap((envValue) =>
      [true, false, undefined].map((persisted) => ({ negative, positive, envValue, persisted })),
    ),
  ),
);

describe("compact metadata tri-state startup", () => {
  test.each(compactPreferenceCases)(
    "negative=$negative positive=$positive env=$envValue persisted=$persisted (local only)",
    ({ negative, positive, envValue, persisted }) => {
      const args = [
        ...(positive ? ["--actions-compact-metadata"] : []),
        ...(negative ? ["--no-actions-compact-metadata"] : []),
      ];
      const env = { AUTOMOBILE_ACTIONS_COMPACT_METADATA: envValue } satisfies NodeJS.ProcessEnv;
      const explicit = negative
        ? false
        : positive
          ? true
          : envValue === "0"
            ? false
            : envValue === "1"
              ? true
              : undefined;
      const flags = parseOutputReductionFlags(args, env);
      const startOptions = { ...flags } satisfies DaemonOptions;
      expect(resolveActionsCompactMetadata(flags.actionsCompactMetadata, persisted)).toBe(
        explicit ?? persisted ?? true,
      );
      expect(startOptions.actionsCompactMetadata).toBe(explicit);
      if (explicit === undefined) {
        expect(startOptions).not.toHaveProperty("actionsCompactMetadata");
      }
      const expectedArgs =
        explicit === undefined
          ? []
          : [explicit ? "--actions-compact-metadata" : "--no-actions-compact-metadata"];
      expect(outputReductionFlagsToArgs(startOptions)).toEqual(expectedArgs);
      const managerArgs = serialize(startOptions);
      expect(managerArgs.filter((arg) => arg.includes("actions-compact-metadata"))).toEqual(
        expectedArgs,
      );
      expect(parseDaemonArgs(managerArgs, {}).actionsCompactMetadata).toBe(explicit);
      expect(parseDaemonArgs(args, env).actionsCompactMetadata).toBe(explicit);
      // Connection-scoped (#10377): never a restart reason, never merged into a restart.
      for (const runningValue of [true, false, undefined]) {
        const running = { actionsCompactMetadata: runningValue } satisfies DaemonOptions;
        expect(startupOptionDeficits(startOptions, running)).toEqual([]);
        expect(mergeDaemonOptions(running, startOptions)).not.toHaveProperty(
          "actionsCompactMetadata",
        );
      }
      expect(startupOptionDeficits(startOptions, undefined)).toEqual([]);
      expect(daemonProcessOptions(startOptions)).not.toHaveProperty("actionsCompactMetadata");
    },
  );

  test("neighbouring boolean options still treat false and undefined as no opinion", () => {
    for (const key of REUSE_CRITICAL_OPTION_KEYS) {
      expect(startupOptionDeficits({ [key]: false }, { [key]: true })).toEqual([]);
      expect(startupOptionDeficits({}, { [key]: true })).toEqual([]);
      expect(startupOptionDeficits({ [key]: true }, { [key]: false })).toHaveLength(1);
      expect(mergeDaemonOptions({ [key]: true }, { [key]: false })[key]).toBe(true);
    }
    expect(startupOptionDeficits({ toolResultsNoStructuredContent: true }, {})).toEqual([]);
    expect(REUSE_CRITICAL_OPTION_KEYS).not.toContain("actionsCompactMetadata");
    expect(STARTUP_OPTION_DEFICIT_KEYS).not.toContain("actionsCompactMetadata");
  });
});

describe("daemonProcessEnvironment managed slot config (#11286)", () => {
  test("does not hand the proxy's managed slot config to the spawned daemon", () => {
    const env = daemonProcessEnvironment({ AUTOMOBILE_MANAGED_SLOT_CONFIG: "p1.json", KEEP: "1" });
    expect(env.AUTOMOBILE_MANAGED_SLOT_CONFIG).toBeUndefined();
    expect(env.KEEP).toBe("1");
  });
});
