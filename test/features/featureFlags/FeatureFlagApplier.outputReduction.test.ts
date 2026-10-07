import { Daemon } from "../../../src/daemon/daemon";
import type { DaemonOptions } from "../../../src/daemon/types";
import { FeatureFlagService } from "../../../src/features/featureFlags/FeatureFlagService";
import { FakeFeatureFlagRepository } from "../../fakes/FakeFeatureFlagRepository";
import {
  outputReductionFlagsToArgs,
  parseOutputReductionFlags,
  resolveActionsCompactMetadata,
} from "../../../src/utils/outputReductionFlags";
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

const localCases = [true, false, undefined].flatMap((persisted) =>
  [true, false, undefined].map((explicit) => ({ persisted, explicit })),
);

test.each(localCases)(
  "persisted=$persisted explicit=$explicit resolves local behavior without inferring a relay choice",
  async ({ persisted, explicit }) => {
    const previous = serverConfig.isActionsCompactMetadataEnabled();
    const repository = new FakeFeatureFlagRepository();
    if (persisted !== undefined) {
      await repository.upsertFlag("actions-compact-metadata", persisted);
    }
    const service = new FeatureFlagService(repository, new DefaultFeatureFlagApplier());
    const args =
      explicit === undefined
        ? []
        : [explicit ? "--actions-compact-metadata" : "--no-actions-compact-metadata"];
    const flags = parseOutputReductionFlags(args, {});
    try {
      await service.initialize();
      if (flags.actionsCompactMetadata !== undefined) {
        await service.setFlag("actions-compact-metadata", flags.actionsCompactMetadata);
      }
      const effective = resolveActionsCompactMetadata(
        flags.actionsCompactMetadata,
        service.isEnabled("actions-compact-metadata"),
      );
      serverConfig.setActionsCompactMetadataEnabled(effective);
      expect(serverConfig.isActionsCompactMetadataEnabled()).toBe(explicit ?? persisted ?? true);
      expect(service.isEnabled("actions-compact-metadata")).toBe(explicit ?? persisted ?? true);
      const relay = parseDaemonArgs(outputReductionFlagsToArgs(flags), {});
      expect(relay.actionsCompactMetadata).toBe(explicit);
      // Invoke only the pure config application method; no daemon is constructed or started.
      const daemonState = { options: { ...relay } } satisfies { options: DaemonOptions };
      Daemon.prototype["applyToolOutputOptions"].call(daemonState, relay);
      expect(daemonState.options.actionsCompactMetadata).toBe(explicit ?? persisted ?? true);
    } finally {
      serverConfig.setActionsCompactMetadataEnabled(previous);
    }
  },
);
