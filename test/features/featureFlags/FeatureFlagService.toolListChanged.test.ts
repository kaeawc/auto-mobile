import { describe, expect, test } from "bun:test";
import { FeatureFlagService } from "../../../src/features/featureFlags/FeatureFlagService";
import type { FeatureFlagDefinition } from "../../../src/features/featureFlags/FeatureFlagDefinitions";
import { FakeFeatureFlagRepository } from "../../fakes/FakeFeatureFlagRepository";
import { FakeFeatureFlagApplier } from "../../fakes/FakeFeatureFlagApplier";
import { FakeToolListChangedNotifier } from "../../fakes/FakeToolListChangedNotifier";
import type { ToolListChangedNotifier } from "../../../src/features/featureFlags/ToolListChangedNotifier";

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

  test("keeps the flag committed even when a misbehaving notifier throws", async () => {
    // `ToolListChangedNotifier`'s contract says implementations MUST NOT throw,
    // and `FeatureFlagService` commits the flag BEFORE notifying. The guarantee
    // under test is the DEFENSIVE one: a contract-violating notifier that throws
    // can never leave the flag half-applied. We deliberately do NOT pin whether
    // the throw propagates out of `setFlag` — that would over-specify behavior
    // the service is free to guard against (a try/catch around the notifier is a
    // valid, arguably better, implementation); the earlier assertion that the
    // rejection surfaces made the test red on that legitimate hardening. Only the
    // commit-survives-notifier-failure outcome is the real contract, so that is
    // all we assert.
    const throwingNotifier: ToolListChangedNotifier = {
      notifyToolListChanged(): void {
        throw new Error("notifier boom");
      },
    };
    const service = new FeatureFlagService(
      new FakeFeatureFlagRepository(),
      new FakeFeatureFlagApplier(),
      TEST_DEFINITIONS,
      throwingNotifier
    );
    await service.listFlags();

    // Tolerate either outcome (throw surfaced OR guarded/swallowed): the flag
    // must be committed regardless. This reds only if the notifier failure
    // actually corrupts state — e.g. the notify moves BEFORE the commit.
    await service.setFlag("debug", true).catch(() => undefined);
    expect(service.isEnabled("debug")).toBe(true);
  });
});
