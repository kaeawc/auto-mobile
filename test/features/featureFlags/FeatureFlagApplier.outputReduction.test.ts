import { FeatureFlagService } from "../../../src/features/featureFlags/FeatureFlagService";
import { FakeFeatureFlagRepository } from "../../fakes/FakeFeatureFlagRepository";
import { outputReductionFlagsToArgs } from "../../../src/utils/outputReductionFlags";
import { parseDaemonArgs } from "../../../src/daemon/cli/daemonArgs";
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
 * EC4: FEATURE_FLAG_DEFINITIONS registers compact metadata default true and other keys false.
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

test("persisted compact metadata false restores full metadata and relays an explicit off", async () => {
  const previous = serverConfig.isActionsCompactMetadataEnabled();
  const repository = new FakeFeatureFlagRepository();
  await repository.upsertFlag("actions-compact-metadata", false);
  const service = new FeatureFlagService(repository, new DefaultFeatureFlagApplier());
  try {
    await service.initialize();
    expect(serverConfig.isActionsCompactMetadataEnabled()).toBe(false);
    expect(
      parseDaemonArgs(
        outputReductionFlagsToArgs({
          actionsCompactMetadata: service.isEnabled("actions-compact-metadata"),
        }),
        {},
      ).actionsCompactMetadata,
    ).toBe(false);
  } finally {
    serverConfig.setActionsCompactMetadataEnabled(previous);
  }
});
