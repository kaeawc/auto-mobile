import { describe, expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { ObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { DefaultHierarchyCapture } from "../../../src/features/observe/HierarchyCapture";
import {
  normalizeIosHierarchy,
  projectActionableHierarchy,
} from "../../../src/features/observe/HierarchyNormalization";
import { extractHierarchyScreenSize } from "../../../src/features/observe/hierarchyScreenSize";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { resolveElementScreenSize } from "../../../src/features/utility/ElementGeometry";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { nodeBounds } from "../../../src/models/ViewHierarchyResult";
import { parseBounds } from "../../../src/utils/bounds";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { issue8379Hierarchy } from "../../fixtures/issue8379Hierarchy";
import portraitCapture from "../../fixtures/observe/ios-reminders-xctest-noise-before.json";

function device(platform: "ios" | "android" = "ios", panelCount = 2): BootedDevice {
  return {
    deviceId: "fixture-screen-size",
    name: "Fixture device",
    platform,
    displays: {
      panels: Array.from({ length: panelCount }, (_, index) => ({
        key: String(index),
        role: index === 0 ? "inner" : "cover",
        sizePx: { width: 2853, height: 2007 },
      })),
      postures: ["opened", "closed"],
    },
  };
}

function createTap(
  hierarchy: ViewHierarchyResult,
  platform: "ios" | "android" = "ios",
  panels = 2,
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return new TapOnElement(device(platform, panels), new FakeAdbExecutor(), {
    timer,
    hierarchyCapture: new FakeHierarchyCapture(() => hierarchy, platform),
    tapStrategy: new FakeTapStrategy(),
    selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
  });
}

function replace(tap: TapOnElement, hierarchy: ViewHierarchyResult): ObserveResult {
  const observation: ObserveResult = {
    observationId: "fixture-observation",
    updatedAt: 1,
    screenSize: { width: 669, height: 951 },
  };
  tap["replaceObservationHierarchy"](observation, hierarchy, false);
  return observation;
}

/** Derived from captured nodes: remove pixels and the collection's full-frame evidence. */
function sparseDuoHierarchy(offscreen = false): ViewHierarchyResult {
  const hierarchy = issue8379Hierarchy();
  const root = hierarchy.hierarchy.node!;
  const navigation = structuredClone(root.node![0]);
  if (offscreen) {
    const bounds = parseBounds(nodeBounds(navigation))!;
    // Derived geometry, not captured: translate the captured bar up by 200 points.
    navigation.$ = {
      ...navigation.$,
      bounds: { ...bounds, top: bounds.top - 200, bottom: bounds.bottom - 200 },
    };
  }
  root.node = [navigation];
  delete hierarchy.pixelWidth;
  delete hierarchy.pixelHeight;
  return hierarchy;
}

describe("tapOn iOS multi-panel screen size", () => {
  test.each([false, true])(
    "raw Duo replacement agrees with observe (normalized=%s)",
    async (normalized) => {
      const raw = issue8379Hierarchy();
      const hierarchy = normalized ? normalizeIosHierarchy(raw) : raw;
      expect(resolveElementScreenSize(hierarchy)).toEqual({ width: 669, height: 951 });
      const tap = createTap(hierarchy);
      const captured = await tap["refreshViewHierarchy"](50);
      expect(captured).toBe(hierarchy);
      const observation = replace(tap, captured!);
      // The constructed instance is the real ObserveScreen; this pure method uses
      // HierarchyCollector.extractScreenSize without collecting from any device.
      const observeSize = (tap.observeScreen as ObserveScreen).extractScreenSizeFromHierarchy(
        hierarchy,
      );
      expect(observeSize).toEqual({ width: 951, height: 669 });
      expect(observation.screenSize).toEqual(extractHierarchyScreenSize(raw, true)!);
      expect(observation.screenSize).toEqual(observeSize!);
    },
  );

  test("folded two-panel device keeps a captured portrait screen", () => {
    // Captured portrait iPhone tree reused as a cover-screen stand-in, not a Duo capture.
    const hierarchy = structuredClone(portraitCapture.viewHierarchy);
    expect(replace(createTap(hierarchy), hierarchy).screenSize).toEqual({
      width: 393,
      height: 852,
    });
    expect(extractHierarchyScreenSize(hierarchy, true)).toEqual({ width: 393, height: 852 });
  });

  test.each([0, 1])("iPhone with %i panels deliberately keeps legacy raw metadata", (panels) => {
    const hierarchy = issue8379Hierarchy();
    expect(extractHierarchyScreenSize(hierarchy)).toEqual({ width: 951, height: 669 });
    expect(replace(createTap(hierarchy, "ios", panels), hierarchy).screenSize).toEqual(
      resolveElementScreenSize(hierarchy)!,
    );
    expect(replace(createTap(hierarchy, "ios", panels), hierarchy).screenSize).toEqual({
      width: 669,
      height: 951,
    });
  });

  test.each([1, 2])("Android with %i panels keeps legacy raw metadata", (panels) => {
    const hierarchy = issue8379Hierarchy();
    expect(replace(createTap(hierarchy, "android", panels), hierarchy).screenSize).toEqual({
      width: 669,
      height: 951,
    });
    expect(replace(createTap(hierarchy, "android", panels), hierarchy).screenSize).toEqual(
      resolveElementScreenSize(hierarchy)!,
    );
  });

  test("projected and normalized Duo trees retain the recorded landscape size", () => {
    const hierarchy = projectActionableHierarchy(
      "ios",
      normalizeIosHierarchy(issue8379Hierarchy()),
      true,
    );
    expect(resolveElementScreenSize(hierarchy)).toEqual({ width: 951, height: 669 });
    expect(replace(createTap(hierarchy), hierarchy).screenSize).toEqual({
      width: 951,
      height: 669,
    });
  });

  test("missing root bounds fall back to the captured legacy dimensions", () => {
    const hierarchy = issue8379Hierarchy();
    delete hierarchy.hierarchy.node;
    expect(extractHierarchyScreenSize(hierarchy, true)).toEqual({ width: 669, height: 951 });
    expect(replace(createTap(hierarchy), hierarchy).screenSize).toEqual({
      width: 669,
      height: 951,
    });
  });

  test("multi-panel overflow without pixels differs from the flag-less selector viewport", () => {
    const hierarchy = sparseDuoHierarchy();
    expect(extractHierarchyScreenSize(hierarchy)).toEqual({ width: 669, height: 951 });
    expect(extractHierarchyScreenSize(hierarchy, true)).toEqual({ width: 951, height: 669 });
    expect(replace(createTap(hierarchy), hierarchy).screenSize).toEqual({
      width: 951,
      height: 669,
    });
  });

  test("projection preserves size after pruning its overflow evidence, including capture's shallow copy", async () => {
    const source = sparseDuoHierarchy(true);
    expect(extractHierarchyScreenSize(source, true)).toEqual({ width: 951, height: 669 });
    const projected = projectActionableHierarchy("ios", source, true);
    expect(projected.hierarchy.node?.node).toBeUndefined();
    expect(extractHierarchyScreenSize(projected, true)).toEqual({ width: 669, height: 951 });
    expect(replace(createTap(projected), projected).screenSize).toEqual({
      width: 951,
      height: 669,
    });
    const projectedAgain = projectActionableHierarchy("ios", projected, true);
    expect(resolveElementScreenSize(projectedAgain)).toEqual({ width: 951, height: 669 });

    const capture = new DefaultHierarchyCapture(
      "ios",
      {
        readCached: async () => source,
        readFresh: async () => source,
        projectVisible: (hierarchy) => projectActionableHierarchy("ios", hierarchy, true),
      },
      new FakeTimer(),
      new FakeIdGenerator(),
    );
    const snapshot = await capture.capture({ freshness: "fresh" });
    expect(replace(createTap(snapshot.hierarchy), snapshot.hierarchy).screenSize).toEqual({
      width: 951,
      height: 669,
    });
  });

  test("collection target clipped to the captured navigation match dispatches the landscape fallback point", async () => {
    const hierarchy = issue8379Hierarchy();
    const parser = new DefaultElementParser();
    const navigation = parser.parseNodeBounds(hierarchy.hierarchy.node!.node![0])!;
    const collection = parser.parseNodeBounds(hierarchy.hierarchy.node!.node![1])!;
    // Derived selectable text and clickable affordance, not captured attributes.
    navigation.text = "Navigation fixture";
    collection.clickable = true;
    // Fake selection pairs two real captured bounds; it does not assert that
    // the sibling collection was a captured clickable ancestor of the bar.
    const selector = new FakeElementSelector(collection);
    selector.nextMatchedElement = navigation;
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const tap = new TapOnElement(device(), new FakeAdbExecutor(), {
      timer,
      elementSelector: selector,
      hierarchyCapture: new FakeHierarchyCapture(() => hierarchy, "ios"),
      tapStrategy: new FakeTapStrategy(),
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    });
    const observation = replace(tap, hierarchy);
    const points: Array<{ x: number; y: number }> = [];
    tap.observedInteraction = async (action) => ({ ...(await action(observation)), observation });
    tap.executeiOSTap = async (_action, x, y) => {
      points.push({ x, y });
    };
    tap.prepareSelectionCapture = async () => null;
    tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
      observation: current,
    });
    tap.captureTerminalObservationScreenshot = async () => {};
    tap.recordDeferredPredictionOutcome = async () => {};
    tap.enforceFreshnessConsistencyWithEffect = () => {};
    const result = await tap.execute({ text: navigation.text, action: "tap" });
    expect(result.success).toBe(true);
    expect(points).toEqual([{ x: 475, y: 53 }]);
    const visible = tap["visibleTapBounds"](
      {
        element: collection,
        matchedElement: navigation,
        indexInMatches: 0,
        totalMatches: 1,
        strategy: "first",
      },
      hierarchy,
      tap["getScreenSizeFromHierarchy"](hierarchy),
    );
    expect(visible).toEqual({ left: 0, top: 24, right: 951, bottom: 82 });
    expect(observation.screenSize).toEqual({ width: 951, height: 669 });
  });
});
