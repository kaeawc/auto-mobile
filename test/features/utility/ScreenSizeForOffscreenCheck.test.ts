import { expect, test, spyOn } from "bun:test";
import type { ElementBounds, ViewHierarchyResult } from "../../../src/models";
import {
  screenSizeForOffscreenCheck,
  hasVisibleScreenPart,
  type ScreenSizeForOffscreenCheckOptions,
} from "../../../src/features/utility/ElementGeometry";
import { identifyObservedHierarchy } from "../../../src/features/observe/HierarchyCapture";
import { logger } from "../../../src/utils/logger";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { findWaitForElement } from "../../../src/server/observeTools";
import { projectActionableHierarchy } from "../../../src/features/observe/HierarchyNormalization";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { issue8379Hierarchy } from "../../fixtures/issue8379Hierarchy";
import {
  issue8379SelectionHierarchy,
  selectionFixtureDevice,
} from "../../fixtures/issue8379SelectionHierarchy";
import { iosProjectionFixture } from "../../fixtures/iosProjectionFixture";
import androidHome from "../../fixtures/observe/android-home.json";
import collapsed from "../../fixtures/observe/ctrlproxy-headerless-two-notification-group-collapsed.json";
import expanded from "../../fixtures/observe/ctrlproxy-headerless-two-notification-group-expanded.json";
import fractional from "../../fixtures/observe/ios-fractional-bounds.json";
import remindersBefore from "../../fixtures/observe/ios-reminders-xctest-noise-before.json";
import remindersAfter from "../../fixtures/observe/ios-reminders-xctest-noise-after.json";

interface Row {
  name: string;
  capture: () => ViewHierarchyResult;
  platform: "android" | "ios";
  panels?: number;
  center: [number, number];
  accepted: boolean;
  sizeOptions?: ScreenSizeForOffscreenCheckOptions;
}

function missingSizeCapture(): ViewHierarchyResult {
  const capture = issue8379Hierarchy();
  delete capture.screenWidth;
  delete capture.screenHeight;
  delete capture.hierarchy.node;
  return capture;
}

const rows: Row[] = [
  // owner decision D43 (#6523): one screen-size source. Metadata-only selector
  // and wait formerly treated unknown as visible; supplied observation now rejects.
  {
    name: "observation fallback: unknown accepted -> rejected",
    capture: missingSizeCapture,
    platform: "android",
    center: [750, 53],
    accepted: false,
    sizeOptions: { observationScreenSize: { width: 100, height: 100 } },
  },
  {
    name: "missing everything unchanged unknown/accepted",
    capture: missingSizeCapture,
    platform: "android",
    center: [750, 53],
    accepted: true,
  },
  {
    name: "other display observation ignored",
    capture: () => ({ ...missingSizeCapture(), displayId: 7, panelUniqueId: "external" }),
    platform: "android",
    center: [750, 53],
    accepted: true,
    sizeOptions: {
      observationScreenSize: { width: 100, height: 100 },
      display: { displayId: 0, panelUniqueId: "default" },
    },
  },
  // owner decision D43 (#6523): one screen-size source. Android resolver formerly
  // rejected inside-display/outside-root; now all accept. Display 1080x2400 is
  // inferred from android-home, not captured here; non-fullscreen-root capture owed.
  ...[collapsed, expanded].flatMap((fixture, index): Row[] => [
    {
      name: `Android narrow root ${index}: rejected -> accepted`,
      capture: () => ({
        ...structuredClone(fixture.viewHierarchy),
        screenWidth: 1080,
        screenHeight: 2400,
      }),
      platform: "android",
      center: [500, 2350],
      accepted: true,
    },
    {
      name: `Android narrow root ${index}: outside display unchanged rejected`,
      capture: () => ({
        ...structuredClone(fixture.viewHierarchy),
        screenWidth: 1080,
        screenHeight: 2400,
      }),
      platform: "android",
      center: [500, 2450],
      accepted: false,
    },
  ]),
  // owner decision D43 (#6523): one screen-size source. Single-panel selector,
  // tapAny, tapOn and wait formerly rejected x=750; now accepted. y=800 formerly
  // accepted by those four; now rejected by all, using runner-proven landscape.
  {
    name: "raw single-panel iOS right: rejected -> accepted",
    capture: issue8379Hierarchy,
    platform: "ios",
    panels: 1,
    center: [750, 53],
    accepted: true,
  },
  {
    name: "raw single-panel iOS bottom: accepted -> rejected",
    capture: issue8379Hierarchy,
    platform: "ios",
    panels: 1,
    center: [500, 800],
    accepted: false,
  },
  // owner decision D43 (#6523): one screen-size source. Flag-less raw wait and
  // legacy selector formerly rejected; explicit multi-panel context now accepts.
  {
    name: "multi-panel selection: existing action decisions unchanged accepted",
    capture: issue8379SelectionHierarchy,
    platform: "ios",
    panels: 2,
    center: [750, 53],
    accepted: true,
  },
  // owner decision D43 (#6523): one screen-size source. These captured and
  // projection-fixture rows were accepted before and remain accepted.
  {
    name: "android-home unchanged",
    capture: () => structuredClone(androidHome.viewHierarchy),
    platform: "android",
    center: [500, 1000],
    accepted: true,
  },
  {
    name: "fractional iOS unchanged",
    capture: () => structuredClone(fractional.viewHierarchy),
    platform: "ios",
    center: [200, 400],
    accepted: true,
  },
  {
    name: "reminders before unchanged",
    capture: () => structuredClone(remindersBefore.viewHierarchy),
    platform: "ios",
    center: [200, 400],
    accepted: true,
  },
  {
    name: "reminders after unchanged",
    capture: () => structuredClone(remindersAfter.viewHierarchy),
    platform: "ios",
    center: [200, 400],
    accepted: true,
  },
  {
    name: "projection fixture unchanged",
    capture: iosProjectionFixture,
    platform: "ios",
    center: [20, 20],
    accepted: true,
  },
  ...[false, true].map((multi): Row => ({
    name: `projected landscape unchanged multi=${multi}`,
    capture: () => projectActionableHierarchy("ios", issue8379Hierarchy(), multi),
    platform: "ios",
    panels: multi ? 2 : 1,
    center: [750, 53],
    accepted: true,
  })),
];

function withTarget(capture: ViewHierarchyResult, center: [number, number]) {
  // Derived geometry/affordance from captured #8379 navigation, not a parser
  // fixture fabricated from tool output. Capture of these target positions is owed.
  const target = structuredClone(issue8379Hierarchy().hierarchy.node!.node![0]);
  const [x, y] = center;
  const bounds: ElementBounds = { left: x - 5, right: x + 5, top: y - 5, bottom: y + 5 };
  target.$ = { ...target.$, bounds, text: "D43 target", clickable: "true", enabled: "true" };
  const root = capture.hierarchy.node;
  if (Array.isArray(root)) {
    root.push(target);
  } else if (root) {
    root.node = [...(Array.isArray(root.node) ? root.node : []), target];
  } else {
    capture.hierarchy.node = [target];
  }
  return { hierarchy: capture, target: new DefaultElementParser().parseNodeBounds(target)! };
}

test.each(rows)("four consumers: $name", (row) => {
  const { hierarchy, target } = withTarget(row.capture(), row.center);
  const device = selectionFixtureDevice(row.platform, row.panels ?? 1);
  const options = {
    ...row.sizeOptions,
    platform: row.platform,
    iosMultiPanel: row.platform === "ios" && (row.panels ?? 1) > 1,
  };
  const tapAny = new TapAnyElement(device, new FakeAdbExecutor(), {
    timer: new FakeTimer(),
    elementSelector: new FakeElementSelector(target),
  });
  const tapOn = new TapOnElement(device, new FakeAdbExecutor(), { timer: new FakeTimer() });
  const selection = {
    element: target,
    indexInMatches: 0,
    totalMatches: 1,
    strategy: "first" as const,
  };
  const resolver = new ResolverElementSelector(undefined, undefined, options);
  expect({
    tapAny: tapAny["findClickableElement"]({ action: "tap" }, hierarchy, options).element !== null,
    tapOn: !tapOn["isElementTapTargetOffScreen"](
      selection,
      hierarchy,
      tapOn["getScreenSizeFromHierarchy"](hierarchy, options),
    ),
    wait:
      findWaitForElement(
        new ElementResolver(),
        { text: "D43 target" },
        hierarchy,
        row.platform,
        new Map(),
        options,
      ) !== null,
    resolver: resolver.selectByText(hierarchy, "D43 target").element !== null,
  }).toEqual({
    tapAny: row.accepted,
    tapOn: row.accepted,
    wait: row.accepted,
    resolver: row.accepted,
  });
});

test("fallback logs once per resolution, primary paths do not log", () => {
  // owner decision D43 (#6523): one screen-size source. Independent reads had
  // no common fallback trace; now observation/iOS metadata fallback logs once.
  // Missing everything remains unknown/not-off-screen.
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  try {
    const observationScreenSize = { width: 1080, height: 2400 };
    const missing = missingSizeCapture();
    expect(screenSizeForOffscreenCheck(missing, { observationScreenSize })).toBe(
      observationScreenSize,
    );
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0][0]).toContain("observation; capture screen size unavailable");
    debug.mockClear();
    const metadataOnly = { ...missing, screenWidth: 669, screenHeight: 951 };
    expect(screenSizeForOffscreenCheck(metadataOnly, { platform: "ios" })).toEqual({
      width: 669,
      height: 951,
    });
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0][0]).toContain(
      "capture metadata; iOS projection/root geometry unavailable",
    );
    debug.mockClear();
    expect(screenSizeForOffscreenCheck(issue8379Hierarchy(), { platform: "ios" })).toEqual({
      width: 951,
      height: 669,
    });
    expect(screenSizeForOffscreenCheck(metadataOnly, { platform: "android" })).toEqual({
      width: 669,
      height: 951,
    });
    expect(debug).not.toHaveBeenCalled();
    expect(screenSizeForOffscreenCheck(missing)).toBeUndefined();
    expect(!hasVisibleScreenPart({ left: 700, right: 800, top: 24, bottom: 82 }, undefined)).toBe(
      false,
    );
  } finally {
    debug.mockRestore();
  }
});

test("platform precedence is explicit, snapshot, projection stamp, then Android order", () => {
  const raw = issue8379Hierarchy();
  expect(screenSizeForOffscreenCheck(raw)).toEqual({ width: 669, height: 951 });
  identifyObservedHierarchy("ios", raw, "fresh", new FakeTimer(), new FakeIdGenerator());
  expect(screenSizeForOffscreenCheck(raw)).toEqual({ width: 951, height: 669 });
  expect(screenSizeForOffscreenCheck(raw, { platform: "android" })).toEqual({
    width: 669,
    height: 951,
  });
  const projected = projectActionableHierarchy("ios", issue8379SelectionHierarchy(), true);
  // Derived stale metadata after projection proves the tree stamp, not metadata,
  // is the inference source; a capture with such conflicting fields is owed.
  projected.screenWidth = 669;
  projected.screenHeight = 951;
  expect(screenSizeForOffscreenCheck(projected)).toEqual({ width: 951, height: 669 });
});

test.each([
  { displayId: 7, panelUniqueId: "external" },
  { displayId: 0, panelUniqueId: "external" },
  { displayId: 7, panelUniqueId: "default" },
  undefined,
])("targeted fallback only accepts matching capture identity: %j", (display) => {
  // owner decision D43 (#6523): one screen-size source. Previously an observation
  // fallback could cross displays; now mismatched/unknown identity is ignored.
  const hierarchy = { ...missingSizeCapture(), displayId: 7, panelUniqueId: "external" };
  const observationScreenSize = { width: 1080, height: 2400 };
  const expected =
    display?.displayId === 7 && display.panelUniqueId === "external"
      ? observationScreenSize
      : undefined;
  expect(screenSizeForOffscreenCheck(hierarchy, { observationScreenSize, display })).toEqual(
    expected,
  );
  hierarchy.screenWidth = 800;
  hierarchy.screenHeight = 600;
  expect(screenSizeForOffscreenCheck(hierarchy, { observationScreenSize, display })).toEqual({
    width: 800,
    height: 600,
  });
});

test("tapOn replacement cannot relabel a carried default-display size as a new display", () => {
  // owner decision D43 (#6523): one screen-size source. Previously retained
  // another display's size; now clears it to the existing unknown representation.
  const tap = new TapOnElement(selectionFixtureDevice("android"), new FakeAdbExecutor(), {
    timer: new FakeTimer(),
  });
  const previous = { ...missingSizeCapture(), displayId: 0, panelUniqueId: "default" };
  const observation = {
    observationId: "display-replacement",
    updatedAt: 1,
    viewHierarchy: previous,
    screenSize: { width: 1080, height: 2400 },
  };
  tap["replaceObservationHierarchy"](
    observation,
    { ...missingSizeCapture(), displayId: 7, panelUniqueId: "external" },
    false,
  );
  // ObserveResult requires a size; use ObserveScreen's existing unknown-size
  // representation rather than retaining another display's dimensions.
  expect(observation.screenSize).toEqual({ width: 0, height: 0 });
});
