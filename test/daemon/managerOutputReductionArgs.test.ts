import { describe, expect, test } from "bun:test";
import { parseDaemonArgs } from "../../src/daemon/manager";
import {
  outputReductionFlagsToArgs,
  OUTPUT_REDUCTION_FLAG_SPECS,
} from "../../src/utils/outputReductionFlags";

/**
 * EC5: the daemon child receives each output-reduction flag as a CLI arg and
 * parseDaemonArgs (the daemon-side reader) maps it back onto DaemonOptions.
 * This is the forward half of the MCP-process -> daemon-process hand-off.
 */
describe("parseDaemonArgs output-reduction flags", () => {
  test("defaults are undefined when no flag is passed", () => {
    const options = parseDaemonArgs([]);
    expect(options.observeResultIncludeElements).toBeUndefined();
    expect(options.toolResultsNoStructuredContent).toBeUndefined();
    expect(options.actionsDiffObserve).toBeUndefined();
    expect(options.actionsNoObserve).toBeUndefined();
  });

  test("--observe-result-include-elements sets observeResultIncludeElements", () => {
    expect(parseDaemonArgs(["--observe-result-include-elements"]).observeResultIncludeElements).toBe(true);
  });

  test("--tool-results-no-structured-content sets toolResultsNoStructuredContent", () => {
    expect(parseDaemonArgs(["--tool-results-no-structured-content"]).toolResultsNoStructuredContent).toBe(true);
  });

  test("--actions-diff-observe sets actionsDiffObserve", () => {
    expect(parseDaemonArgs(["--actions-diff-observe"]).actionsDiffObserve).toBe(true);
  });

  test("--actions-no-observe sets actionsNoObserve", () => {
    expect(parseDaemonArgs(["--actions-no-observe"]).actionsNoObserve).toBe(true);
  });

  test("all output-reduction flags parse together", () => {
    const options = parseDaemonArgs([
      "--observe-result-include-elements",
      "--tool-results-no-structured-content",
      "--actions-diff-observe",
      "--actions-no-observe",
    ]);
    expect(options.observeResultIncludeElements).toBe(true);
    expect(options.toolResultsNoStructuredContent).toBe(true);
    expect(options.actionsDiffObserve).toBe(true);
    expect(options.actionsNoObserve).toBe(true);
  });

  test("retired output-reduction flags are silently ignored (no throw, no option set)", () => {
    // These behaviors are now unconditional defaults; the old opt-in flags are
    // dead no-ops with no migration error or warning.
    const retired = [
      "--observe-result-drop-elements",
      "--observe-result-compact",
      "--observe-result-project-skeleton",
      "--tool-results-compact-json",
      "--observe-focus-scope",
      "--observe-overview",
      "--observe-region",
    ];
    const options = parseDaemonArgs(retired) as Record<string, unknown>;
    for (const flag of retired) {
      const field = flag.replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      expect(options[field]).toBeUndefined();
    }
  });
});

/**
 * The serialize (manager push) and parse (daemon read) halves of the relay are
 * hand-adjacent flag strings; this round-trip guards them from drifting apart.
 */
describe("output-reduction daemon-arg round trip", () => {
  test("outputReductionFlagsToArgs emits nothing when all flags are off", () => {
    expect(outputReductionFlagsToArgs({})).toEqual([]);
  });

  test("each flag serializes to an arg that parses back to the same option", () => {
    for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
      const args = outputReductionFlagsToArgs({ [spec.field]: true });
      expect(args).toEqual([spec.cli]);
      const options = parseDaemonArgs(args);
      expect(options[spec.field]).toBe(true);
    }
  });

  test("all-on flags round-trip through serialize -> parse intact", () => {
    const allOn = Object.fromEntries(
      OUTPUT_REDUCTION_FLAG_SPECS.map(spec => [spec.field, true])
    );
    const options = parseDaemonArgs(outputReductionFlagsToArgs(allOn));
    for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
      expect(options[spec.field]).toBe(true);
    }
  });
});

describe("event-all markers daemon arg relay", () => {
  test("--event-all-markers parses a csv into DaemonOptions", () => {
    expect(parseDaemonArgs(["--event-all-markers", "@,/,#"]).eventAllMarkers)
      .toEqual(["@", "/", "#"]);
  });

  test("--event-all-markers=<csv> parses into DaemonOptions", () => {
    expect(parseDaemonArgs(["--event-all-markers=@,/,#"]).eventAllMarkers)
      .toEqual(["@", "/", "#"]);
  });

  test("trims and drops empties on parse", () => {
    expect(parseDaemonArgs(["--event-all-markers", " @ , / , "]).eventAllMarkers)
      .toEqual(["@", "/"]);
  });

  test("falls back to AUTOMOBILE_EVENT_ALL_MARKERS", () => {
    expect(parseDaemonArgs([], { AUTOMOBILE_EVENT_ALL_MARKERS: "@,:" }).eventAllMarkers)
      .toEqual(["@", ":"]);
  });

  test("preserves an explicit empty CLI override over AUTOMOBILE_EVENT_ALL_MARKERS", () => {
    const options = parseDaemonArgs(
      ["--event-all-markers="],
      { AUTOMOBILE_EVENT_ALL_MARKERS: "@,:" }
    );
    expect(options.eventAllMarkers).toEqual([]);
    expect(options.eventAllMarkersCliOverride).toBe(true);
  });

  test("CLI flag wins over AUTOMOBILE_EVENT_ALL_MARKERS", () => {
    const options = parseDaemonArgs(
      ["--event-all-markers", "#"],
      { AUTOMOBILE_EVENT_ALL_MARKERS: "@" }
    );
    expect(options.eventAllMarkers).toEqual(["#"]);
    expect(options.eventAllMarkersCliOverride).toBe(true);
  });

  test("ignores missing or flag-shaped values", () => {
    expect(parseDaemonArgs(["--event-all-markers"]).eventAllMarkers).toBeUndefined();
    expect(parseDaemonArgs(["--event-all-markers", "--debug"]).eventAllMarkers).toBeUndefined();
  });

  test("defaults to undefined when the flag is absent", () => {
    expect(parseDaemonArgs([]).eventAllMarkers).toBeUndefined();
  });
});

describe("tool outputs directory daemon arg relay", () => {
  test("--tool-outputs-dir parses into DaemonOptions", () => {
    expect(parseDaemonArgs(["--tool-outputs-dir", "/tmp/artifacts"]).toolOutputsDir)
      .toBe("/tmp/artifacts");
  });

  test("--tool-output-dir alias parses into DaemonOptions", () => {
    expect(parseDaemonArgs(["--tool-output-dir", "/tmp/artifacts"]).toolOutputsDir)
      .toBe("/tmp/artifacts");
  });

  test("legacy AUTO_MOBILE_TOOL_OUTPUTS_DIR env alias parses into DaemonOptions", () => {
    expect(parseDaemonArgs([], { AUTO_MOBILE_TOOL_OUTPUTS_DIR: "/tmp/legacy-artifacts" }).toolOutputsDir)
      .toBe("/tmp/legacy-artifacts");
  });

  test("ignores missing or flag-shaped values", () => {
    expect(parseDaemonArgs(["--tool-outputs-dir"]).toolOutputsDir).toBeUndefined();
    expect(parseDaemonArgs(["--tool-outputs-dir", "--debug"]).toolOutputsDir).toBeUndefined();
  });
});
