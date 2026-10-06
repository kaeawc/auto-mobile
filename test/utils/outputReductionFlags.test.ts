import { describe, expect, test } from "bun:test";
import {
  parseOutputReductionFlags,
  parseOutputReductionFlagOverrides,
  OUTPUT_REDUCTION_FLAG_SPECS,
} from "../../src/utils/outputReductionFlags";

describe("parseOutputReductionFlags", () => {
  test("defaults compact metadata on and neighbouring flags off", () => {
    const flags = parseOutputReductionFlags([], {});
    expect(flags).toEqual({
      observeResultIncludeElements: false,
      toolResultsNoStructuredContent: false,
      actionsDiffObserve: false,
      actionsNoObserve: false,
      actionsCompactMetadata: true,
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

  test("env zero disables every flag; other values preserve defaults", () => {
    for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
      const flags = parseOutputReductionFlags([], { [spec.env]: "0" });
      expect(flags[spec.field]).toBe(false);
      const flagsTrue = parseOutputReductionFlags([], { [spec.env]: "true" });
      expect(flagsTrue[spec.field]).toBe(spec.field === "actionsCompactMetadata");
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

test("compact metadata environment zero opts out", () => {
  expect(
    parseOutputReductionFlags([], { AUTOMOBILE_ACTIONS_COMPACT_METADATA: "0" })
      .actionsCompactMetadata,
  ).toBe(false);
});

test("compact metadata negative relay argument overrides inherited environment", () => {
  expect(
    parseOutputReductionFlags(["--no-actions-compact-metadata"], {
      AUTOMOBILE_ACTIONS_COMPACT_METADATA: "1",
    }).actionsCompactMetadata,
  ).toBe(false);
  expect(
    parseOutputReductionFlags(["--no-actions-compact-metadata", "--actions-compact-metadata"], {})
      .actionsCompactMetadata,
  ).toBe(true);
});

test("startup defaults are not explicit overrides of saved feature flags", () => {
  expect(parseOutputReductionFlagOverrides([], {})).toEqual({});
  expect(
    parseOutputReductionFlagOverrides([], { AUTOMOBILE_ACTIONS_COMPACT_METADATA: "true" }),
  ).toEqual({});
  expect(
    parseOutputReductionFlagOverrides([], { AUTOMOBILE_ACTIONS_COMPACT_METADATA: "0" }),
  ).toEqual({ actionsCompactMetadata: false });
  expect(
    parseOutputReductionFlagOverrides(["--actions-compact-metadata"], {
      AUTOMOBILE_ACTIONS_COMPACT_METADATA: "0",
    }),
  ).toEqual({ actionsCompactMetadata: true });
});
