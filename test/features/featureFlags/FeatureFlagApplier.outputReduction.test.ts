import { afterEach, describe, expect, test } from "bun:test";
import { DefaultFeatureFlagApplier } from "../../../src/features/featureFlags/FeatureFlagApplier";
import {
  FEATURE_FLAG_DEFINITIONS,
  type FeatureFlagKey,
} from "../../../src/features/featureFlags/FeatureFlagDefinitions";
import { serverConfig } from "../../../src/utils/ServerConfig";

/**
 * EC2: DefaultFeatureFlagApplier.apply routes each output-reduction key to the
 * matching serverConfig setter (the feature-flag pipeline).
 * EC4: FEATURE_FLAG_DEFINITIONS registers each key, default false.
 */
const CASES: Array<{ key: FeatureFlagKey; read: () => boolean }> = [
  { key: "observe-result-include-elements", read: () => serverConfig.isObserveResultIncludeElementsEnabled() },
  { key: "tool-results-no-structured-content", read: () => serverConfig.isToolResultsNoStructuredContentEnabled() },
  { key: "actions-diff-observe", read: () => serverConfig.isActionsDiffObserveEnabled() },
  { key: "actions-no-observe", read: () => serverConfig.isActionsNoObserveEnabled() },
];

describe("DefaultFeatureFlagApplier output-reduction flags", () => {
  const applier = new DefaultFeatureFlagApplier();

  afterEach(() => {
    for (const { key } of CASES) {
      applier.apply(key, false);
    }
  });

  for (const { key, read } of CASES) {
    test(`apply("${key}", true/false) flips serverConfig`, () => {
      applier.apply(key, true);
      expect(read()).toBe(true);
      applier.apply(key, false);
      expect(read()).toBe(false);
    });
  }
});

describe("FEATURE_FLAG_DEFINITIONS output-reduction flags", () => {
  for (const { key } of CASES) {
    test(`registers "${key}" default off`, () => {
      const def = FEATURE_FLAG_DEFINITIONS.find(d => d.key === key);
      expect(def).toBeDefined();
      expect(def?.defaultValue).toBe(false);
    });
  }
});
