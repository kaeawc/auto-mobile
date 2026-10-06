import { expect, spyOn, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import {
  usesScopedSwipeContainer,
  usesScopedSwipeLookFor,
} from "../../../src/features/action/swipeon/swipeSelectorScopes";
import type { ViewHierarchyResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeTalkBackTapStrategy } from "../../fakes/FakeTalkBackTapStrategy";
import { FakeTalkBackNavigationDriver } from "../../fakes/FakeTalkBackNavigationDriver";
import { scopedSelectionMatrix } from "../../helpers/scopedSelectionMatrix";
import fixture from "../../fixtures/observe/ctrlproxy-notification-group-compact-bounds.json";

const capture: ViewHierarchyResult = { hierarchy: { node: fixture.expanded } };
const nodes = new SearchableHierarchy().project(capture);
const element = nodes.find((node) => node.nativeId === "android:id/title")!.element!;
const device = {
  name: "Scope matrix",
  platform: "android" as const,
  deviceId: "fake-scope-matrix",
};

for (const row of scopedSelectionMatrix) {
  const options = { container: row.container, selectionStrategy: row.selectionStrategy };
  test(`tapOn lookup scope: ${row.name}`, () => {
    const selector = new ResolverElementSelector();
    const select = spyOn(selector, "selectByResourceId");
    const tap = new TapOnElement(device, new FakeAdbExecutor(), {
      timer: new FakeTimer(),
      elementSelector: selector,
    });
    try {
      // Captured column is duplicated, so unique may throw after the call is recorded.
      try {
        tap.findElementInHierarchy(
          { action: "tap", elementId: "android:id/title", ...options },
          capture,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
      expect(select.mock.calls[0]?.[2]?.intentAction).toBe(row.nested ? "tap" : "inspect");
    } finally {
      select.mockRestore();
    }
  });
  test(`adapter missing-container strictness: ${row.name}`, () => {
    const selector = new ResolverElementSelector({
      resolve: () => ({
        chosen: null,
        candidates: [],
        matches: [],
        error: "Container level 1 not found: missing",
      }),
    });
    const select = () =>
      selector.selectByResourceId(capture, "android:id/title", {
        container: row.container,
        strategy: row.selectionStrategy,
      });
    if (row.nested) {
      expect(select).toThrow("Container level 1 not found");
    } else {
      expect(select().element).toBeNull();
    }
  });
  test(`swipe opt-ins: ${row.name}`, () => {
    expect(usesScopedSwipeContainer(row.container)).toBe(row.swipeContainer);
    expect(usesScopedSwipeLookFor(options)).toBe(row.swipeLookFor);
  });
  test(`resolver unique propagation: ${row.name}`, () => {
    const resolver = new ElementResolver(() => 0);
    const result = resolver.resolve(
      { id: "matrix", nodes },
      { elementId: "android:id/title", ...options },
      { action: "inspect" },
    );
    const propagated =
      !!row.container && row.selectionStrategy === "unique" && row.container.index === undefined;
    expect(result.error?.includes("Container level") ?? false).toBe(propagated);
    if (propagated) {
      expect(result.error).toContain("ambiguous");
    }
  });
  test(`tapAny dispatch scope: ${row.name}`, async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const detector = new FakeAccessibilityDetector();
    detector.setTalkBackEnabled(true);
    const strategy = new FakeTalkBackTapStrategy();
    const selector = new FakeElementSelector(element);
    const adapter = new ResolverElementSelector();
    // Preserve the captured hierarchy and fake only selection and availability.
    const hasContainer = spyOn(adapter, "hasContainer").mockReturnValue(true);
    const select = spyOn(adapter, "selectClickable").mockImplementation((...args) =>
      selector.selectClickable(...args),
    );
    const tap = new TapAnyElement(device, new FakeAdbExecutor(), {
      timer,
      elementSelector: adapter,
      accessibilityDetector: detector,
      talkBackStrategy: strategy,
      talkBackDriverFactory: { createDriver: () => new FakeTalkBackNavigationDriver() },
      accessibilityService: {
        requestTapCoordinates: async () => ({ success: true, totalTimeMs: 0 }),
        requestAction: async (action) => ({ success: true, action, totalTimeMs: 0 }),
        requestNodeAction: async (action) => ({ success: true, action, totalTimeMs: 0 }),
        supportsNodeActionSelectors: async () => true,
      },
    });
    tap.observedInteraction = (action) =>
      action({ viewHierarchy: capture, screenSize: { width: 1080, height: 2400 } });
    tap.setRefreshViewHierarchyForTesting(async () => capture);
    try {
      const result = await tap.execute({ action: "tap", ...options });
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(strategy.preciseTapCalls.length > 0).toBe(row.nested);
    } finally {
      hasContainer.mockRestore();
      select.mockRestore();
    }
  });
  test(`tapAny retry scope: ${row.name}`, async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const detector = new FakeAccessibilityDetector();
    detector.setTalkBackEnabled(false);
    const strategy = new FakeTalkBackTapStrategy();
    const selector = new FakeElementSelector(element);
    const adapter = new ResolverElementSelector();
    // Preserve the captured hierarchy and fake only selection and availability.
    const hasContainer = spyOn(adapter, "hasContainer").mockReturnValue(true);
    const select = spyOn(adapter, "selectClickable").mockImplementation((...args) =>
      selector.selectClickable(...args),
    );
    const tap = new TapAnyElement(device, new FakeAdbExecutor(), {
      timer,
      elementSelector: adapter,
      accessibilityDetector: detector,
      talkBackStrategy: strategy,
      talkBackDriverFactory: { createDriver: () => new FakeTalkBackNavigationDriver() },
      accessibilityService: {
        requestTapCoordinates: async () => ({ success: true, totalTimeMs: 0 }),
        requestAction: async (action) => ({ success: true, action, totalTimeMs: 0 }),
        requestNodeAction: async (action) => ({ success: true, action, totalTimeMs: 0 }),
        supportsNodeActionSelectors: async () => true,
      },
    });
    tap.observedInteraction = (action) =>
      action({ viewHierarchy: capture, screenSize: { width: 1080, height: 2400 } });
    tap.setRefreshViewHierarchyForTesting(async () => capture);
    try {
      const result = await tap.execute({ action: "tap", ...options });
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(select.mock.calls.length).toBe(row.anyContainer ? 3 : 2);
    } finally {
      hasContainer.mockRestore();
      select.mockRestore();
    }
  });
}

for (const row of scopedSelectionMatrix) {
  test(`tapOn focus classification: ${row.name}`, () => {
    const selector = new ResolverElementSelector();
    const available = spyOn(selector, "hasContainer").mockReturnValue(true);
    const select = spyOn(selector, "selectByResourceId")
      .mockImplementationOnce(() => {
        throw new ActionableError("strict miss");
      })
      .mockReturnValue({ element: null, indexInMatches: -1, totalMatches: 0, strategy: "first" });
    const tap = new TapOnElement(device, new FakeAdbExecutor(), {
      timer: new FakeTimer(),
      elementSelector: selector,
    });
    try {
      expect(() =>
        tap.findElementInHierarchy(
          {
            action: "focus",
            elementId: "android:id/title",
            container: row.container,
            selectionStrategy: row.selectionStrategy,
          },
          capture,
        ),
      ).toThrow("strict miss");
      expect(select.mock.calls.length).toBe(row.nested ? 2 : 1);
    } finally {
      available.mockRestore();
      select.mockRestore();
    }
  });
}
