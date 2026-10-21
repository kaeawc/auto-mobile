import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { Program } from "oxc-parser";
import { parseGuardSource } from "../../lint/astGuard";
import { collectSourceFacts } from "../../lint/sourceFacts";
import { TOOL_DEFINITION_AFFECTING_FLAGS } from "../../../src/features/featureFlags/FeatureFlagDefinitions";
import type { FeatureFlagKey } from "../../../src/features/featureFlags/FeatureFlagDefinitions";

// AST drift guard (issue #2963): TOOL_DEFINITION_AFFECTING_FLAGS is a
// hand-maintained set that must stay in sync with the config the tool-list output
// actually depends on. `getToolDefinitions` (ToolDefinitionListing.ts, split out of
// toolRegistry.ts in #13693) decides the advertised outputSchema and
// `getToolAvailabilityGateReasons` (toolRegistry.ts) decides tool availability.
// This test parses both modules (oxc) and extracts every config getter those two methods call and asserts each maps
// to a flag that is (or is deliberately excluded from) the set. If a new getter is
// added without updating this mapping, the test fails loudly pointing the author here.

const TOOL_REGISTRY_PATH = path.resolve(import.meta.dir, "../../../src/server/toolRegistry.ts");
const TOOL_LISTING_PATH = path.resolve(
  import.meta.dir,
  "../../../src/server/ToolDefinitionListing.ts",
);

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

/**
 * Config getters that select tool-list shape or availability, referenced in one method:
 * `serverConfig.isXxxEnabled()` calls plus the bare imported `isDebugModeEnabled()`.
 */
function findConfigGetters(program: Program, method: string): string[] {
  const facts = collectSourceFacts(program, { method });
  const getters = new Set<string>();
  // `serverConfig.isXEnabled()` and `this.serverConfig.isXEnabled()`
  for (const member of facts.calledMembers) {
    const match = /^serverConfig\.(is\w+Enabled)$/.exec(member);
    if (match) {
      getters.add(match[1]);
    }
  }
  // The imported free function, bare or reached through a namespace/receiver.
  if (
    facts.calledNames.includes("isDebugModeEnabled") ||
    facts.calledMethodNames.includes("isDebugModeEnabled")
  ) {
    getters.add("isDebugModeEnabled");
  }
  return [...getters];
}

describe("TOOL_DEFINITION_AFFECTING_FLAGS drift guard", () => {
  const registryProgram = parseGuardSource(
    TOOL_REGISTRY_PATH,
    fs.readFileSync(TOOL_REGISTRY_PATH, "utf8"),
  );
  const listingProgram = parseGuardSource(
    TOOL_LISTING_PATH,
    fs.readFileSync(TOOL_LISTING_PATH, "utf8"),
  );
  const gettersUsed = [
    ...findConfigGetters(listingProgram, "getToolDefinitions"),
    ...findConfigGetters(registryProgram, "getToolAvailabilityGateReasons"),
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
