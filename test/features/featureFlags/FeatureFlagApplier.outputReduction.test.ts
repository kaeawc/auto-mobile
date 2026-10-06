import { FeatureFlagService } from "../../../src/features/featureFlags/FeatureFlagService";
import { FakeFeatureFlagRepository } from "../../fakes/FakeFeatureFlagRepository";
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
 * EC4: FEATURE_FLAG_DEFINITIONS registers each key, compact metadata default true; other defaults false.
 */
const CASES: Array<{ key: FeatureFlagKey; read: () => boolean }> = [
  {
    key: "observe-result-include-elements",
    read: () => serverConfig.isObserveResultIncludeElementsEnabled(),
  },
  {
    key: "tool-results-no-structured-content",
    read: () => serverConfig.isToolResultsNoStructuredContentEnabled(),
  },
  { key: "actions-diff-observe", read: () => serverConfig.isActionsDiffObserveEnabled() },
  { key: "actions-compact-metadata", read: () => serverConfig.isActionsCompactMetadataEnabled() },
  { key: "actions-no-observe", read: () => serverConfig.isActionsNoObserveEnabled() },
];

describe("DefaultFeatureFlagApplier output-reduction flags", () => {
  const applier = new DefaultFeatureFlagApplier();

  afterEach(() => {
    for (const { key } of CASES) {
      applier.apply(key, key === "actions-compact-metadata");
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
    test(`registers "${key}" with its default`, () => {
      const def = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def?.defaultValue).toBe(key === "actions-compact-metadata");
    });
  }
});

test("compact metadata feature-flag false restores full metadata", () => {
  const applier = new DefaultFeatureFlagApplier();
  const previous = serverConfig.isActionsCompactMetadataEnabled();
  try {
    const definition = FEATURE_FLAG_DEFINITIONS.find((d) => d.key === "actions-compact-metadata")!;
    applier.apply(definition.key, definition.defaultValue);
    expect(serverConfig.isActionsCompactMetadataEnabled()).toBe(true);
    applier.apply(definition.key, false);
    expect(serverConfig.isActionsCompactMetadataEnabled()).toBe(false);
  } finally {
    serverConfig.setActionsCompactMetadataEnabled(previous);
  }
});

test("feature-flag initialization defaults compact metadata on and preserves saved false", async () => {
  const previous = serverConfig.isActionsCompactMetadataEnabled();
  const definitions = FEATURE_FLAG_DEFINITIONS.filter((d) => d.key === "actions-compact-metadata");
  const repository = new FakeFeatureFlagRepository();
  try {
    const service = new FeatureFlagService(
      repository,
      new DefaultFeatureFlagApplier(),
      definitions,
    );
    await service.initialize();
    expect(serverConfig.isActionsCompactMetadataEnabled()).toBe(true);
    await service.setFlag("actions-compact-metadata", false);
    expect(serverConfig.isActionsCompactMetadataEnabled()).toBe(false);
    serverConfig.setActionsCompactMetadataEnabled(true);
    await new FeatureFlagService(
      repository,
      new DefaultFeatureFlagApplier(),
      definitions,
    ).initialize();
    expect(serverConfig.isActionsCompactMetadataEnabled()).toBe(false);
  } finally {
    serverConfig.setActionsCompactMetadataEnabled(previous);
  }
});
