import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { TOOL_DEFINITION_AFFECTING_FLAGS } from "../../../src/features/featureFlags/FeatureFlagDefinitions";
import type { FeatureFlagKey } from "../../../src/features/featureFlags/FeatureFlagDefinitions";

// Source-scan drift guard (issue #2963): TOOL_DEFINITION_AFFECTING_FLAGS is a
// hand-maintained set that must stay in sync with the config the tool-list output
// actually depends on. `getToolDefinitions` decides the advertised outputSchema and
// `getToolAvailabilityGateReasons` decides tool availability — both in toolRegistry.ts.
// This test extracts every config getter those two methods call and asserts each maps
// to a flag that is (or is deliberately excluded from) the set. If a new getter is
// added without updating this mapping, the test fails loudly pointing the author here.

const TOOL_REGISTRY_PATH = path.resolve(import.meta.dir, "../../../src/server/toolRegistry.ts");

// Maps a config getter referenced by the tool-list methods to the runtime feature
// flag that drives it, or `null` when it is NOT a runtime-toggleable feature flag
// (so a tools/list_changed notification is neither possible nor needed).
const CONFIG_GETTER_TO_FLAG: Record<string, FeatureFlagKey | null> = {
  // getToolDefinitions — outputSchema advertisement. Bounds compaction is now an
  // unconditional default (no getter, always-advertised tuple), so the only
  // remaining runtime toggle here is the structuredContent suppression.
  isToolResultsNoStructuredContentEnabled: "tool-results-no-structured-content",
  // getToolAvailabilityGateReasons — tool availability
  isDebugModeEnabled: "debug",
  // embedded SDK mode is set outside the feature-flag system (no setFlag path), so
  // it cannot be runtime-toggled and correctly triggers no notification.
  isEmbeddedSdkEnabled: null,
};

/** Brace-match the body of a method given its name, so we scan only that method. */
function extractMethodBody(source: string, methodName: string): string {
  const signatureIndex = source.indexOf(`${methodName}(`);
  if (signatureIndex === -1) {
    throw new Error(`Method ${methodName} not found in toolRegistry.ts`);
  }
  // Skip the parameter list first — a default like `= {}` would otherwise be
  // mistaken for the body's opening brace.
  let cursor = source.indexOf("(", signatureIndex);
  let parenDepth = 0;
  for (; cursor < source.length; cursor++) {
    if (source[cursor] === "(") {
      parenDepth++;
    } else if (source[cursor] === ")") {
      parenDepth--;
      if (parenDepth === 0) {
        cursor++;
        break;
      }
    }
  }
  const openBrace = source.indexOf("{", cursor);
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(openBrace, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces scanning ${methodName}`);
}

/** Config getters that select tool-list shape or availability, referenced in a body. */
function findConfigGetters(body: string): string[] {
  const getters = new Set<string>();
  // serverConfig.isXxxEnabled()
  for (const match of body.matchAll(/serverConfig\.(is\w+Enabled)\(\)/g)) {
    getters.add(match[1]);
  }
  // bare isDebugModeEnabled() (imported free function, not on serverConfig)
  for (const match of body.matchAll(/\b(isDebugModeEnabled)\(\)/g)) {
    getters.add(match[1]);
  }
  return [...getters];
}

describe("TOOL_DEFINITION_AFFECTING_FLAGS drift guard", () => {
  const source = fs.readFileSync(TOOL_REGISTRY_PATH, "utf8");
  const gettersUsed = [
    ...findConfigGetters(extractMethodBody(source, "getToolDefinitions")),
    ...findConfigGetters(extractMethodBody(source, "getToolAvailabilityGateReasons")),
  ];

  test("the tool-list methods actually reference some config getters (scan is live)", () => {
    expect(gettersUsed.length).toBeGreaterThan(0);
  });

  test("every config getter the tool-list methods use is mapped (no unmapped drift)", () => {
    const unmapped = gettersUsed.filter((getter) => !(getter in CONFIG_GETTER_TO_FLAG));
    expect(
      unmapped,
      `New config getter(s) affect tools/list but are not mapped in this test: ${unmapped.join(", ")}. ` +
        "Add each to CONFIG_GETTER_TO_FLAG (and to TOOL_DEFINITION_AFFECTING_FLAGS if it maps to a runtime flag).",
    ).toEqual([]);
  });

  test("every runtime-toggleable tool-list getter is in TOOL_DEFINITION_AFFECTING_FLAGS", () => {
    for (const getter of gettersUsed) {
      const flag = CONFIG_GETTER_TO_FLAG[getter];
      if (flag !== null && flag !== undefined) {
        expect(
          TOOL_DEFINITION_AFFECTING_FLAGS.has(flag),
          `${getter} maps to flag "${flag}" which affects tools/list but is missing from TOOL_DEFINITION_AFFECTING_FLAGS.`,
        ).toBe(true);
      }
    }
  });

  test("the set contains no flag that no longer affects tool definitions", () => {
    const flagsBackedByGetters = new Set(
      gettersUsed
        .map((getter) => CONFIG_GETTER_TO_FLAG[getter])
        .filter((flag): flag is FeatureFlagKey => flag !== null && flag !== undefined),
    );
    for (const flag of TOOL_DEFINITION_AFFECTING_FLAGS) {
      expect(
        flagsBackedByGetters.has(flag),
        `TOOL_DEFINITION_AFFECTING_FLAGS lists "${flag}" but no tool-list getter maps to it — remove it or update the mapping.`,
      ).toBe(true);
    }
  });
});
