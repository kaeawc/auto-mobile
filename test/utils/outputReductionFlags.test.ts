import { parseDaemonArgs } from "../../src/daemon/cli/daemonArgs";
import { describe, expect, test } from "bun:test";
import {
  parseOutputReductionFlags,
  outputReductionFlagsToArgs,
  OUTPUT_REDUCTION_FLAG_SPECS,
} from "../../src/utils/outputReductionFlags";

describe("parseOutputReductionFlags", () => {
  test("leaves compact metadata unspecified; other flags default off", () => {
    const flags = parseOutputReductionFlags([], {});
    expect(flags).toEqual({
      observeResultIncludeElements: false,
      toolResultsNoStructuredContent: false,
      actionsDiffObserve: false,
      actionsNoObserve: false,
    });
  });

  test("each flag flips true from its CLI flag alone", () => {
    for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
      const flags = parseOutputReductionFlags([spec.cli], {});
      expect(flags[spec.field]).toBe(true);
    }
  });

  test('each flag flips true from its env var alone (=== "1")', () => {
    for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
      const flags = parseOutputReductionFlags([], { [spec.env]: "1" });
      expect(flags[spec.field]).toBe(true);
    }
  });

  test('env values other than "1" do not enable the flag', () => {
    for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
      const flags = parseOutputReductionFlags([], { [spec.env]: "0" });
      expect(flags[spec.field]).toBe(false);
      const flagsTrue = parseOutputReductionFlags([], { [spec.env]: "true" });
      expect(flagsTrue[spec.field]).toBe(
        spec.field === "actionsCompactMetadata" ? undefined : false,
      );
    }
  });

  test("CLI takes precedence: CLI flag enables even when env is unset or disabled", () => {
    for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
      // CLI present, env explicitly disabled -> CLI wins (true)
      const flags = parseOutputReductionFlags([spec.cli], { [spec.env]: "0" });
      expect(flags[spec.field]).toBe(true);
      // CLI present, env absent -> true
      const flagsNoEnv = parseOutputReductionFlags([spec.cli], {});
      expect(flagsNoEnv[spec.field]).toBe(true);
    }
  });

  test("CLI and env both set both resolve true", () => {
    for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
      const flags = parseOutputReductionFlags([spec.cli], { [spec.env]: "1" });
      expect(flags[spec.field]).toBe(true);
    }
  });

  test("resolves flags independently without cross-talk", () => {
    const flags = parseOutputReductionFlags(["--observe-result-include-elements"], {
      AUTOMOBILE_ACTIONS_NO_OBSERVE: "1",
    });
    expect(flags.observeResultIncludeElements).toBe(true);
    expect(flags.actionsNoObserve).toBe(true);
    expect(flags.toolResultsNoStructuredContent).toBe(false);
    expect(flags.actionsDiffObserve).toBe(false);
  });
});

test("compact metadata CLI/env flag is registered", () => {
  expect(parseOutputReductionFlags(["--actions-compact-metadata"], {}).actionsCompactMetadata).toBe(
    true,
  );
  expect(
    parseOutputReductionFlags([], { AUTOMOBILE_ACTIONS_COMPACT_METADATA: "1" })
      .actionsCompactMetadata,
  ).toBe(true);
});

test("compact metadata opt-out survives the daemon relay", () => {
  for (const flags of [
    parseOutputReductionFlags([], { AUTOMOBILE_ACTIONS_COMPACT_METADATA: "0" }),
    parseOutputReductionFlags(["--no-actions-compact-metadata"], {
      AUTOMOBILE_ACTIONS_COMPACT_METADATA: "1",
    }),
  ]) {
    expect(flags.actionsCompactMetadata).toBe(false);
    const args = outputReductionFlagsToArgs(flags);
    expect(args).toEqual(["--no-actions-compact-metadata"]);
    expect(parseDaemonArgs(args, {}).actionsCompactMetadata).toBe(false);
  }
  expect(
    parseDaemonArgs([], { AUTOMOBILE_ACTIONS_COMPACT_METADATA: "0" }).actionsCompactMetadata,
  ).toBe(false);
  expect(
    parseDaemonArgs(["--actions-compact-metadata"], { AUTOMOBILE_ACTIONS_COMPACT_METADATA: "0" })
      .actionsCompactMetadata,
  ).toBe(true);
  expect(
    parseOutputReductionFlags(["--actions-compact-metadata", "--no-actions-compact-metadata"], {})
      .actionsCompactMetadata,
  ).toBe(false);
});
