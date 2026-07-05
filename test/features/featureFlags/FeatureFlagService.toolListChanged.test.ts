import { describe, expect, test } from "bun:test";
import { FeatureFlagService } from "../../../src/features/featureFlags/FeatureFlagService";
import type { FeatureFlagDefinition } from "../../../src/features/featureFlags/FeatureFlagDefinitions";
import { FakeFeatureFlagRepository } from "../../fakes/FakeFeatureFlagRepository";
import { FakeFeatureFlagApplier } from "../../fakes/FakeFeatureFlagApplier";
import { FakeToolListChangedNotifier } from "../../fakes/FakeToolListChangedNotifier";

// Covers the three flags that change what `tools/list` returns (outputSchema
// advertisement or tool availability) plus one unrelated flag, so we can assert
// notifications fire only for tool-definition-affecting toggles (issue #2963).
const TEST_DEFINITIONS: FeatureFlagDefinition[] = [
  { key: "debug", label: "Debug", description: "debug", defaultValue: false },
  {
    key: "tool-results-no-structured-content",
    label: "No structured content",
    description: "strip",
    defaultValue: false,
  },
  {
    key: "observe-result-compact",
    label: "Compact observe",
    description: "compact",
    defaultValue: false,
  },
  { key: "ui-perf-mode", label: "UI perf", description: "ui perf", defaultValue: false },
];

const makeService = (notifier: FakeToolListChangedNotifier) =>
  new FeatureFlagService(
    new FakeFeatureFlagRepository(),
    new FakeFeatureFlagApplier(),
    TEST_DEFINITIONS,
    notifier
  );

describe("FeatureFlagService tools/list_changed notifications", () => {
  test.each([
    "tool-results-no-structured-content",
    "observe-result-compact",
    "debug",
  ] as const)("toggling %s at runtime emits exactly one notification", async key => {
    const notifier = new FakeToolListChangedNotifier();
    const service = makeService(notifier);
    await service.listFlags(); // force initialize()

    await service.setFlag(key, true);

    expect(notifier.count).toBe(1);
  });

  test("toggling an unrelated flag emits no notification", async () => {
    const notifier = new FakeToolListChangedNotifier();
    const service = makeService(notifier);
    await service.listFlags();

    await service.setFlag("ui-perf-mode", true);

    expect(notifier.count).toBe(0);
  });

  test("re-setting a tool-defn flag to its current value emits nothing (no storm)", async () => {
    const notifier = new FakeToolListChangedNotifier();
    const service = makeService(notifier);
    await service.listFlags();

    // Default is false; set to false again — no change, so no notification.
    await service.setFlag("debug", false);

    expect(notifier.count).toBe(0);
  });

  test("initialize() does not emit even though it applies tool-defn flags", async () => {
    const notifier = new FakeToolListChangedNotifier();
    const service = makeService(notifier);

    await service.initialize();

    expect(notifier.count).toBe(0);
  });

  test("toggling on then off emits once per real change (restores schema)", async () => {
    const notifier = new FakeToolListChangedNotifier();
    const service = makeService(notifier);
    await service.listFlags();

    await service.setFlag("tool-results-no-structured-content", true);
    await service.setFlag("tool-results-no-structured-content", false);

    expect(notifier.count).toBe(2);
  });

  test("defaults to a no-op notifier when none is injected", async () => {
    const service = new FeatureFlagService(
      new FakeFeatureFlagRepository(),
      new FakeFeatureFlagApplier(),
      TEST_DEFINITIONS
    );

    // Must not throw despite no notifier being provided.
    const updated = await service.setFlag("debug", true);
    expect(updated.enabled).toBe(true);
  });
});
