import { describe, expect, test } from "bun:test";
import { DaemonManager, parseDaemonArgs } from "../../src/daemon/manager";
import { parseArgs } from "../../src/cli/parseArgs";
import {
  REUSE_CRITICAL_ARRAY_OPTION_KEYS,
  REUSE_CRITICAL_OPTION_KEYS,
} from "../../src/daemon/daemonMcpProxy";
import { OUTPUT_REDUCTION_FLAG_SPECS } from "../../src/utils/outputReductionFlags";
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
  const built = (
    manager as unknown as {
      withDaemonOptions: (
        l: { command: string; args: string[] },
        o: DaemonOptions,
      ) => { args: string[] };
    }
  ).withDaemonOptions({ command: "auto-mobile", args: [] }, options);
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

  test("exact tool defaults round-trip through daemon startup arguments", () => {
    const options: DaemonOptions = {
      enabledTools: ["clipboard", "sqlQuery"],
      disabledTools: ["observe"],
    };

    expect(parseDaemonArgs(serialize(options))).toMatchObject(options);
  });
});

describe("reuse-critical drift guard", () => {
  test("every output-reduction flag (incl. observe-scope) is reuse-critical", () => {
    // A reuse-critical flag forces a preserving daemon restart when a client
    // requests it and the running daemon lacks it — the mechanism that makes the
    // observe-scope flags propagate to an already-running daemon. Spec-driven, so
    // a new output-reduction flag is covered automatically; this pins that.
    for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
      expect(REUSE_CRITICAL_OPTION_KEYS).toContain(spec.field);
    }
  });

  test("explicit tool defaults participate in daemon reuse reconciliation", () => {
    expect(REUSE_CRITICAL_ARRAY_OPTION_KEYS).toContain("enabledTools");
    expect(REUSE_CRITICAL_ARRAY_OPTION_KEYS).toContain("disabledTools");
  });
});
