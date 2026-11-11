import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ViewHierarchyResult } from "../../../src/models";
import { identifyObservedHierarchy } from "../../../src/features/observe/HierarchyCapture";
import {
  applicationWindowSafeTapPoint,
  isFullyCoveredByApplicationWindow,
} from "../../../src/features/observe/ApplicationWindowCover";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { FakeTimer } from "../../fakes/FakeTimer";
import { wireCapture } from "../../helpers/wireCapture";
import { DefaultObserveElementCollector } from "../../../src/features/observe/ObserveElementCollector";
import { projectSkeleton } from "../../../src/features/observe/output/SkeletonProjection";
import { CTRL_PROXY_PACKAGE } from "../../../src/ctrlProxy/constants";
import { capturedFloatingCoverHierarchy } from "../../helpers/prototypeWindowCapture";

const captured: { viewHierarchy: ViewHierarchyResult } = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/android-xr/observe-settings-home-hidden-systemui.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
// Isolate the two reported hidden cover windows and the Settings window. The serialized
// capture also contains a visible caption and home-space windows in unrelated panel spaces.
const hierarchy = identifyObservedHierarchy(
  "android",
  {
    ...captured.viewHierarchy,
    hierarchy: {},
    windows: captured.viewHierarchy.windows?.filter((window) => [16, 17, 38].includes(window.id!)),
  },
  "cached-ok",
  { timer: new FakeTimer() },
).hierarchy;

test.each([
  [1076, 1252, 696],
  [60, 164, 568],
] as const)("hidden system windows do not cover row at %s", (top, bottom, right) => {
  const entry = new SearchableHierarchy()
    .project(hierarchy)
    .find(
      (node) =>
        node.bounds?.top === top &&
        node.bounds.bottom === bottom &&
        node.bounds.left === 48 &&
        node.bounds.right === right,
    )!;
  const target = new DefaultElementParser().parseNodeBounds(entry.source)!;
  const bounds = target.bounds;
  const point = { x: (bounds.left + bounds.right) / 2, y: (top + bottom) / 2 };
  expect(applicationWindowSafeTapPoint(hierarchy, target, bounds, { point }).point).toEqual(point);
  expect(isFullyCoveredByApplicationWindow(hierarchy, target, bounds)).toBe(false);
});

test("a visible application dialog still covers the target", () => {
  const bounds = { left: 0, top: 0, right: 400, bottom: 100 };
  const row = { text: "Row", bounds };
  const dialog = { text: "Dialog", "visible-to-user": true, bounds };
  const visible = wireCapture({
    hierarchy: { node: [row, dialog] },
    windows: [
      { type: 1, windowLayer: 0, hierarchy: row },
      { type: 1, windowLayer: 1, hierarchy: dialog },
    ],
  });
  const target = new DefaultElementParser().parseNodeBounds(row)!;
  expect(
    applicationWindowSafeTapPoint(visible, target, bounds, { point: { x: 200, y: 50 } }).point,
  ).toBeNull();
  expect(isFullyCoveredByApplicationWindow(visible, target, bounds)).toBe(true);
});

test.each([true, false])("visible foreign caption cover with XR=%s", (xr) => {
  const capture = structuredClone(captured.viewHierarchy);
  capture.hierarchy = {};
  capture.windows = capture.windows?.filter((window) =>
    (xr ? [1, 37, 38] : [37, 38]).includes(window.id!),
  );
  const full = identifyObservedHierarchy("android", capture, "cached-ok", {
    timer: new FakeTimer(),
  }).hierarchy;
  const caption = full.windows!.find((window) => window.id === 37)!;
  const parser = new DefaultElementParser();
  parser.traverseNode(caption.hierarchy!, (node) => {
    Object.assign(node, { "visible-to-user": true });
  });
  const search = new SearchableHierarchy()
    .project(full)
    .find((entry) => entry.bounds?.left === 48 && entry.bounds.top === 60)!;
  const target = parser.parseNodeBounds(search.source)!;
  const point = { x: 308, y: 112 };
  const result = applicationWindowSafeTapPoint(full, target, target.bounds, { point });
  if (xr) {
    expect(result).toEqual({ point });
  } else {
    expect(result.coveredByKind).toBe("window");
    expect(result.point).not.toEqual(point);
  }
});

test("XR still respects a same-window control over a scrolling row", () => {
  const full = capturedFloatingCoverHierarchy();
  full.windows = full.windows?.filter((window) => window.id !== 170);
  full.windows!.push(captured.viewHierarchy.windows!.find((window) => window.id === 1)!);
  const parser = new DefaultElementParser();
  const bounds = { left: 550, top: 1589, right: 996, bottom: 1715 };
  const app = full.windows!.find((window) => window.id === 150)!;
  const entries = new SearchableHierarchy().project({ hierarchy: {}, windows: [app] });
  const control = entries.find((entry) => entry.displayedLabel === "Demos" && entry.actionable)!;
  control.source.bounds = { ...bounds };
  const row = entries.find((entry) => entry.elementId === "button_elevated")!;
  const target = parser.parseNodeBounds(row.source)!;
  expect(
    applicationWindowSafeTapPoint(full, target, bounds, {
      point: { x: 773, y: 1652 },
      views: true,
    }),
  ).toMatchObject({ point: null, coveredByKind: "view" });
});

test("XR fallback avoids an own prototype without subtracting foreign panel rectangles", () => {
  const capture = structuredClone(captured.viewHierarchy);
  capture.hierarchy = {};
  capture.windows = capture.windows?.map((window) =>
    window.id === 37
      ? {
          ...window,
          packageName: CTRL_PROXY_PACKAGE,
          type: 4,
          prototypePlacement: "floating" as const,
          bounds: { left: 0, top: 0, right: 384, bottom: 128 },
        }
      : window,
  );
  const full = identifyObservedHierarchy("android", capture, "cached-ok", {
    timer: new FakeTimer(),
  }).hierarchy;
  const search = new SearchableHierarchy()
    .project(full)
    .find((entry) => entry.bounds?.left === 48 && entry.bounds.top === 60)!;
  const target = new DefaultElementParser().parseNodeBounds(search.source)!;
  expect(
    applicationWindowSafeTapPoint(full, target, target.bounds, {
      point: { x: 308, y: 112 },
      ownWindows: "touch",
      views: true,
    }),
  ).toEqual({
    point: { x: 308, y: 146 },
    coveredBy: "an AutoMobile prototype window",
    coveredByKind: "window",
  });
});

test("Settings skeleton offers Storage and Search without occlusion", () => {
  const elements = new DefaultObserveElementCollector().collect(hierarchy, "android");
  const projected = projectSkeleton(elements!, { width: 2560, height: 2558 }, hierarchy);
  const rows = [...projected.skeleton, ...projected.context];
  for (const label of ["Storage", "Search"]) {
    const row = rows.find((candidate) => candidate.label === label);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("occluded");
  }
});

test("the verbatim Settings hierarchy leaves Storage and Search tappable and unoccluded", () => {
  const full = identifyObservedHierarchy("android", captured.viewHierarchy, "cached-ok", {
    timer: new FakeTimer(),
  }).hierarchy;
  const settings = full.windows!.find((window) => window.id === 38)!;
  // Resolve from the owning window tree; serialized merged roots are separate node copies.
  const nodes = new SearchableHierarchy().project({ hierarchy: {}, windows: [settings] });
  for (const [top, bottom, right] of [
    [60, 164, 568],
    [1076, 1252, 696],
  ]) {
    const node = nodes.find(
      (entry) =>
        entry.bounds?.left === 48 &&
        entry.bounds.top === top &&
        entry.bounds.bottom === bottom &&
        entry.bounds.right === right,
    )!;
    const element = new DefaultElementParser().parseNodeBounds(node.source)!;
    const bounds = element.bounds;
    const point = { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
    expect(
      applicationWindowSafeTapPoint(full, element, bounds, {
        point,
        ownWindows: "touch",
        views: true,
      }),
    ).toEqual({ point });
    expect(isFullyCoveredByApplicationWindow(full, element, bounds)).toBe(false);
  }
  const elements = new DefaultObserveElementCollector().collect(full, "android")!;
  const { skeleton, context } = projectSkeleton(elements, { width: 2560, height: 2558 }, full);
  for (const label of ["Storage", "Search"]) {
    const row = [...skeleton, ...context].find((candidate) => candidate.label === label);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("occluded");
  }
});

test.each(["com.android.settings", "com.google.android.permissioncontroller"])(
  "XR application dialog from %s covers a row for taps and observe",
  (packageName) => {
    const capture = structuredClone(captured.viewHierarchy);
    capture.hierarchy = {};
    const app = capture.windows!.find((window) => window.id === 38)!;
    const dialog = structuredClone(app);
    dialog.id = 90;
    dialog.windowLayer = 100;
    dialog.packageName = packageName;
    const parser = new DefaultElementParser();
    const root = parser.extractWindowRootNodes({ hierarchy: {}, windows: [dialog] })[0];
    Object.assign(root, {
      node: [],
      text: "Dialog",
      "resource-id": `${packageName}:id/dialog`,
      "visible-to-user": true,
    });
    dialog.hierarchy = { node: [root] };
    capture.windows = [capture.windows!.find((window) => window.id === 1)!, dialog, app];
    const full = identifyObservedHierarchy("android", capture, "cached-ok", {
      timer: new FakeTimer(),
    }).hierarchy;
    const entry = new SearchableHierarchy()
      .project({ hierarchy: {}, windows: [app] })
      .find((node) => node.bounds?.left === 48 && node.bounds.top === 1076)!;
    const target = parser.parseNodeBounds(entry.source)!;
    expect(
      applicationWindowSafeTapPoint(full, target, target.bounds, {
        point: { x: 372, y: 1164 },
      }),
    ).toMatchObject({ point: null, coveredByKind: "window" });
    expect(isFullyCoveredByApplicationWindow(full, target, target.bounds)).toBe(true);
    const elements = new DefaultObserveElementCollector().collect(full, "android")!;
    const projection = projectSkeleton(elements, { width: 2560, height: 2558 }, full);
    expect(
      [...projection.skeleton, ...projection.context].some(
        (row) => row.label === "Storage" && row.occluded,
      ),
    ).toBe(true);
  },
);

test("phone hidden application windows do not take touches", () => {
  const capture = structuredClone(captured.viewHierarchy);
  capture.hierarchy = {};
  const app = capture.windows!.find((window) => window.id === 38)!;
  const hidden = structuredClone(app);
  hidden.id = 90;
  hidden.windowLayer = 100;
  new DefaultElementParser().traverseNode(hidden.hierarchy!, (node) => {
    Object.assign(node, { "visible-to-user": false });
  });
  capture.windows = [hidden, app];
  const full = identifyObservedHierarchy("android", capture, "cached-ok", {
    timer: new FakeTimer(),
  }).hierarchy;
  const entry = new SearchableHierarchy()
    .project({ hierarchy: {}, windows: [app] })
    .find((node) => node.bounds?.left === 48 && node.bounds.top === 1076)!;
  const target = new DefaultElementParser().parseNodeBounds(entry.source)!;
  const point = { x: 372, y: 1164 };
  expect(applicationWindowSafeTapPoint(full, target, target.bounds, { point })).toEqual({ point });
  expect(isFullyCoveredByApplicationWindow(full, target, target.bounds)).toBe(false);
});
