import { describe, expect, test } from "bun:test";
import { FeatureFlagService } from "../../../src/features/featureFlags/FeatureFlagService";
import type { FeatureFlagDefinition } from "../../../src/features/featureFlags/FeatureFlagDefinitions";
import { FakeFeatureFlagRepository } from "../../fakes/FakeFeatureFlagRepository";
import { FakeFeatureFlagApplier } from "../../fakes/FakeFeatureFlagApplier";
import { FakeToolListChangedNotifier } from "../../fakes/FakeToolListChangedNotifier";
import type { ToolListChangedNotifier } from "../../../src/features/featureFlags/ToolListChangedNotifier";

// Covers the flags that change what `tools/list` returns (outputSchema
// advertisement or tool availability) plus unrelated flags, so we can assert
// notifications fire only for tool-definition-affecting toggles (issue #2963).
// The full set of tool-definition-affecting flags is now exactly
// {debug, tool-results-no-structured-content}; `observe-result-include-elements`
// is an example of a flag that is NOT in that set (dropping/restoring the
// flattened elements array does not change the advertised tool definitions).
const TEST_DEFINITIONS: FeatureFlagDefinition[] = [
  { key: "debug", label: "Debug", description: "debug", defaultValue: false },
  {
    key: "tool-results-no-structured-content",
    label: "No structured content",
    description: "strip",
    defaultValue: false,
  },
  {
    key: "observe-result-include-elements",
    label: "Include elements",
    description: "include elements",
    defaultValue: false,
  },
  { key: "ui-perf-mode", label: "UI perf", description: "ui perf", defaultValue: false },
];

const makeService = (notifier: FakeToolListChangedNotifier) =>
  new FeatureFlagService(
    new FakeFeatureFlagRepository(),
    new FakeFeatureFlagApplier(),
    TEST_DEFINITIONS,
    notifier,
  );

describe("FeatureFlagService tools/list_changed notifications", () => {
  test.each(["tool-results-no-structured-content", "debug"] as const)(
    "toggling %s at runtime emits exactly one notification",
    async (key) => {
      const notifier = new FakeToolListChangedNotifier();
      const service = makeService(notifier);
      await service.listFlags(); // force initialize()

      await service.setFlag(key, true);

      expect(notifier.count).toBe(1);
    },
  );

  test("toggling an unrelated flag emits no notification", async () => {
    const notifier = new FakeToolListChangedNotifier();
    const service = makeService(notifier);
    await service.listFlags();

    await service.setFlag("ui-perf-mode", true);

    expect(notifier.count).toBe(0);
  });

  test("toggling observe-result-include-elements (not tool-defn-affecting) emits no notification", async () => {
    // Dropping/restoring the flattened elements array changes only the payload
    // shape, not the advertised tool definitions, so it is not in
    // TOOL_DEFINITION_AFFECTING_FLAGS and must not trigger a list_changed storm.
    const notifier = new FakeToolListChangedNotifier();
    const service = makeService(notifier);
    await service.listFlags();

    await service.setFlag("observe-result-include-elements", true);

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
      TEST_DEFINITIONS,
    );

    // Must not throw despite no notifier being provided.
    const updated = await service.setFlag("debug", true);
    expect(updated.enabled).toBe(true);
  });

  test("commits the flag before notifying, so a throwing notifier can't roll it back", async () => {
    // ToolListChangedNotifier is documented as best-effort: implementations MUST
    // NOT throw. FeatureFlagService commits the flag BEFORE notifying, so even a
    // contract-violating throw must not undo the committed change. We pin that
    // defensive outcome — the flag stays enabled — WITHOUT over-specifying whether
    // the illegal throw propagates back to the caller. Propagation is an
    // unspecified implementation detail (the contract says the throw can't happen),
    // and asserting `.rejects.toThrow` here would lock in that detail and red a
    // future notifier-guarding improvement.
    const throwingNotifier: ToolListChangedNotifier = {
      notifyToolListChanged(): void {
        throw new Error("notifier boom");
      },
    };
    const service = new FeatureFlagService(
      new FakeFeatureFlagRepository(),
      new FakeFeatureFlagApplier(),
      TEST_DEFINITIONS,
      throwingNotifier,
    );
    await service.listFlags();

    // Tolerate either resolution or rejection: the contract forbids the throw, so
    // its propagation is not the behavior under test — the committed flag is.
    await service.setFlag("debug", true).catch(() => undefined);

    expect(service.isEnabled("debug")).toBe(true);
  });
});
