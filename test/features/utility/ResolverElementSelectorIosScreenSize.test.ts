import { expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { SetUIState } from "../../../src/features/action/SetUIState";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import {
  getHierarchySnapshot,
  identifyObservedHierarchy,
} from "../../../src/features/observe/HierarchyCapture";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { issue8379Hierarchy } from "../../fixtures/issue8379Hierarchy";
import { projectActionableHierarchy } from "../../../src/features/observe/HierarchyNormalization";
import { extractHierarchyScreenSize } from "../../../src/features/observe/hierarchyScreenSize";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import {
  duoSelectionBounds,
  duoSelectionText,
  issue8379SelectionHierarchy,
  selectionFixtureDevice,
} from "../../fixtures/issue8379SelectionHierarchy";
import portraitCapture from "../../fixtures/observe/ios-reminders-xctest-noise-before.json";

test.each([false, true])(
  "production tapOn selector keeps right-hand Duo target (projected=%s)",
  (projected) => {
    const raw = issue8379SelectionHierarchy();
    const hierarchy = projected ? { ...projectActionableHierarchy("ios", raw, true) } : raw;
    expect(extractHierarchyScreenSize(hierarchy)).toEqual({ width: 669, height: 951 });
    if (projected) {
      // The translated overflow witness was pruned; only the derived target remains.
      expect(extractHierarchyScreenSize(hierarchy, true)).toEqual({ width: 669, height: 951 });
    }
    const tap = new TapOnElement(selectionFixtureDevice(), new FakeAdbExecutor(), {
      timer: new FakeTimer(),
    });
    expect(
      tap["elementSelector"].selectByText(hierarchy, duoSelectionText).element?.bounds,
    ).toEqual(duoSelectionBounds);
  },
);

test("drag default selector receives the Duo flag", () => {
  const hierarchy = issue8379SelectionHierarchy();
  const device = selectionFixtureDevice();
  const timer = new FakeTimer();
  const drag = new DragAndDrop(device, new FakeAdbExecutor(), timer);
  expect(drag["selector"].selectByText(hierarchy, duoSelectionText).element?.bounds).toEqual(
    duoSelectionBounds,
  );
});

test("setUIState default selector receives the Duo flag", () => {
  const hierarchy = issue8379SelectionHierarchy();
  const state = new SetUIState(selectionFixtureDevice(), new FakeAdbExecutor(), {
    timer: new FakeTimer(),
  });
  expect(state["findElement"]({ text: duoSelectionText }, hierarchy)?.bounds).toEqual(
    duoSelectionBounds,
  );
});

test("projection stamp takes precedence even in a selector without a device flag", () => {
  const hierarchy = { ...projectActionableHierarchy("ios", issue8379SelectionHierarchy(), true) };
  expect(
    new ResolverElementSelector().selectByText(hierarchy, duoSelectionText).element?.bounds,
  ).toEqual(duoSelectionBounds);
});

test("observe identification projects an unstamped Duo tree with the device flag", () => {
  const snapshot = identifyObservedHierarchy(
    "ios",
    issue8379SelectionHierarchy(),
    "cached-ok",
    new FakeTimer(),
    new FakeIdGenerator(),
    { iosMultiPanel: true },
  );
  expect({
    width: snapshot.hierarchy.screenWidth,
    height: snapshot.hierarchy.screenHeight,
  }).toEqual({ width: 951, height: 669 });
});

test("production observe identification passes the Duo flag on an unstamped cached observation", () => {
  const hierarchy = issue8379SelectionHierarchy();
  const tap = new TapOnElement(selectionFixtureDevice(), new FakeAdbExecutor(), {
    timer: new FakeTimer(),
  });
  const observe = tap.observeScreen;
  if (!(observe instanceof RealObserveScreen)) {
    throw new Error("Expected real observe feature");
  }
  observe["identifyCapture"](
    { viewHierarchy: hierarchy, screenSize: { width: 951, height: 669 } },
    "cached-ok",
  );
  expect(getHierarchySnapshot(hierarchy)?.hierarchy.screenWidth).toBe(951);
  expect(getHierarchySnapshot(hierarchy)?.hierarchy.screenHeight).toBe(669);
});

test("single iPhone uses runner geometry and Android uses capture display metadata", () => {
  for (const device of [
    selectionFixtureDevice("ios", 1),
    selectionFixtureDevice("android", 1),
    selectionFixtureDevice("android", 2),
  ]) {
    for (const raw of [issue8379Hierarchy(), issue8379SelectionHierarchy()]) {
      for (const hierarchy of [raw, projectActionableHierarchy(device.platform, raw)]) {
        const selector = new TapOnElement(device, new FakeAdbExecutor(), {
          timer: new FakeTimer(),
        })["elementSelector"];
        if (!(selector instanceof ResolverElementSelector)) {
          throw new Error("Expected production resolver selector");
        }
        // owner decision D43 (#6523): one screen-size source. Android formerly
        // used root/pixel heuristics; now metadata. iOS root/pixels are unchanged.
        expect(selector["viewport"](hierarchy)).toEqual(
          device.platform === "ios"
            ? extractHierarchyScreenSize(hierarchy)
            : { width: hierarchy.screenWidth!, height: hierarchy.screenHeight! },
        );
      }
    }
  }
});

test.each([false, true])(
  "folded portrait stand-in, single iPhone and Android preserve legacy viewports (projected=%s)",
  (projected) => {
    // Captured portrait iPhone reused as a folded-cover stand-in, not a Duo capture.
    for (const device of [
      selectionFixtureDevice(),
      selectionFixtureDevice("ios", 1),
      selectionFixtureDevice("android"),
    ]) {
      const raw = structuredClone(portraitCapture.viewHierarchy);
      const hierarchy = projected
        ? projectActionableHierarchy(
            device.platform,
            raw,
            device.platform === "ios" && device.displays!.panels.length > 1,
          )
        : raw;
      const selector = new TapOnElement(device, new FakeAdbExecutor(), { timer: new FakeTimer() })[
        "elementSelector"
      ];
      // Exercise the real resolver adapter's viewport without manufacturing a match.
      expect(selector).toBeInstanceOf(ResolverElementSelector);
      if (!(selector instanceof ResolverElementSelector)) {
        throw new Error("Expected production resolver selector");
      }
      expect(selector["viewport"](hierarchy)).toEqual(extractHierarchyScreenSize(hierarchy));
    }
  },
);
