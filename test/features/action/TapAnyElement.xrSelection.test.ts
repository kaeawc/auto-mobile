import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { buildObserveResult } from "../../helpers/observeFixture";
import { runBlockWith } from "../../helpers/observedInteractionStub";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { executeXrNodeClick } from "../../../src/features/action/xrPanelNodeClick";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { identifyObservedHierarchy } from "../../../src/features/observe/HierarchyCapture";
import { findTapAnyClickableElement } from "../../../src/features/action/tapAnyTargetGeometry";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type {
  ViewHierarchyResult,
  ViewHierarchyNode,
  TapAnyElementOptions,
} from "../../../src/models";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { childrenOf, nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { getHierarchyNodeSource } from "../../../src/features/observe/output/elementProvenance";

const capture: {
  viewHierarchy: ViewHierarchyResult;
  screenSize: { width: number; height: number };
} = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/android-xr/observe-settings-home-hidden-systemui.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const hierarchy = identifyObservedHierarchy("android", capture.viewHierarchy, "cached-ok", {
  timer: new FakeTimer(),
}).hierarchy;
const selector = new ResolverElementSelector();
const twoPaneCapture: typeof capture = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/android-xr/observe-settings-subsettings-apps-two-pane-17915.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const twoPaneHierarchy = identifyObservedHierarchy(
  "android",
  twoPaneCapture.viewHierarchy,
  "cached-ok",
  { timer: new FakeTimer() },
).hierarchy;
const liveTwoPaneCapture: typeof capture = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/android-xr/observe-settings-subsettings-apps-two-pane-live-18147.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test.each([
  [{ text: "Apps" }, { left: 48, top: 548, right: 696, bottom: 724 }, "observed"],
  [{ text: "Apps" }, { left: 48, top: 548, right: 696, bottom: 724 }, "refreshed"],
  [{ text: "Apps" }, { left: 48, top: 548, right: 696, bottom: 724 }, "polled"],
  [{ text: "Apps" }, { left: 48, top: 548, right: 696, bottom: 724 }, "refresh-miss"],
  [
    { elementId: "com.android.settings:id/homepage_container" },
    { left: 48, top: 196, right: 696, bottom: 372 },
    "observed",
  ],
] as const)(
  "live two-pane XR click: container=%j bounds=%j capture=%s",
  async (container, bounds, mode) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbClient();
    const service = new FakeCtrlProxy(timer);
    service.setSupportsNodeActionSelectors(true);
    service.setActionResult({ success: true, action: "click", totalTimeMs: 1 });
    const action = new TapAnyElement(
      { name: "fake", platform: "android", deviceId: "fake-xr-live-two-pane" },
      adb,
      {
        timer,
        xrDetector: new FakeAndroidXrDetector(true),
        elementSelector: selector,
        accessibilityDetector: new FakeAccessibilityDetector(),
        accessibilityService: service,
      },
    );
    // Windows are authoritative; serialized merged roots duplicate those same nodes.
    const tree = { ...structuredClone(liveTwoPaneCapture.viewHierarchy), hierarchy: {} };
    const initiallyEmpty = mode === "polled";
    action.observedInteraction = runBlockWith(() => {
      const observation = buildObserveResult({
        viewHierarchy: initiallyEmpty ? { hierarchy: {} } : tree,
        screenSize: liveTwoPaneCapture.screenSize,
        updatedAt: 0,
        systemInsets: { top: 0, left: 0, right: 0, bottom: 0 },
      });
      return mode === "observed" || initiallyEmpty
        ? recordObservationRead(observation)
        : observation;
    });
    let refreshes = 0;
    action.testHooks.setRefreshViewHierarchy(async () => {
      refreshes++;
      return mode === "refresh-miss" && refreshes === 1 ? { hierarchy: {} } : tree;
    });
    const result = await action.execute({ action: "tap", container });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.element?.bounds).toEqual(bounds);
    expect(service.getNodeActionHistory()).toMatchObject([
      { action: "click", expectedBounds: bounds },
    ]);
    expect(service.getNodeActionHistory()).toHaveLength(1);
    expect(service.getTapHistory()).toHaveLength(0);
    expect(adb.getAllCommands()).toHaveLength(0);
    const polls = initiallyEmpty || mode === "refresh-miss" ? 1 : 0;
    expect(timer.getSleepHistory()).toEqual(polls ? [100] : []);
    expect(refreshes).toBe(mode === "observed" ? 0 : mode === "refresh-miss" ? 2 : 1);
  },
);

test("live two-pane XR click still refuses an Apps row outside the resolved toolbar container", async () => {
  const timer = new FakeTimer();
  const tree = identifyObservedHierarchy(
    "android",
    { ...structuredClone(liveTwoPaneCapture.viewHierarchy), hierarchy: {} },
    "cached-ok",
    { timer },
  ).hierarchy;
  const element = select(true, { text: "Apps" }, tree)!;
  expect(element.bounds).toEqual({ left: 48, top: 548, right: 696, bottom: 724 });
  const service = new FakeCtrlProxy(timer);
  service.setSupportsNodeActionSelectors(true);
  await expect(
    executeXrNodeClick(() => service, {
      action: "tap",
      element,
      options: { resolvedHierarchy: tree, container: { text: "Apps", index: 0 } },
      resolveContainer: (hierarchy, options) =>
        selector.resolveContainer(hierarchy, options.container),
    }),
  ).rejects.toThrow(/XR panel coordinate space/);
  expect(service.getNodeActionHistory()).toHaveLength(0);
  expect(service.getTapHistory()).toHaveLength(0);
  expect(timer.getSleepHistory()).toEqual([]);
});
function select(
  xr: boolean,
  container?: TapAnyElementOptions["container"],
  tree = hierarchy,
  scrollableContainer?: boolean,
  selectionStrategy?: TapAnyElementOptions["selectionStrategy"],
) {
  return findTapAnyClickableElement(
    {
      elementSelector: selector,
      isContainerAvailable: () => true,
      platform: "android",
      iosMultiPanel: false,
      xr,
    },
    { action: "tap", container, scrollableContainer, selectionStrategy },
    tree,
    { observationScreenSize: capture.screenSize },
  ).element;
}

test("XR Apps container skips the inert SubSettings toolbar and returns the left row owner", () => {
  const selected = select(true, { text: "Apps" }, twoPaneHierarchy);
  expect(selected?.bounds).toEqual({ left: 48, top: 548, right: 696, bottom: 724 });
  const owner = getHierarchyNodeSource(selected!);
  expect(owner).toBeDefined();
  expect(nodeAttributes(owner!).clickable).toBe("true");
  expect(nodeAttributes(owner!)["collection-row-index"]).toBe(2);
  expect(nodeAttributes(owner!)["view-id"]).toBe("s2-2af87c3887f372cd~bfcaf55f");
});

test("two-pane Settings keeps the homepage ID container and non-XR text behavior", () => {
  expect(
    select(true, { elementId: "com.android.settings:id/homepage_container" }, twoPaneHierarchy)
      ?.bounds,
  ).toEqual({ left: 48, top: 196, right: 696, bottom: 372 });
  expect(select(false, { text: "Apps" }, twoPaneHierarchy)).toBeNull();
});

test.each([
  [{ text: "Apps", selectionStrategy: "unique" }, undefined],
  [{ text: "Apps" }, "unique"],
] as const)("two-pane Apps container preserves unique ambiguity: %j, %s", (container, strategy) => {
  expect(() => select(true, container, twoPaneHierarchy, undefined, strategy)).toThrow("ambiguous");
});

test("two-pane Apps container preserves an explicit inert index and missing-container result", () => {
  expect(select(true, { text: "Apps", index: 0 }, twoPaneHierarchy)).toBeNull();
  expect(select(true, { text: "Missing container" }, twoPaneHierarchy)).toBeNull();
});

test.each([
  [undefined, { left: 48, top: 60, right: 568, bottom: 164 }],
  [{ text: "Apps" }, { left: 48, top: 548, right: 696, bottom: 724 }],
  [
    { elementId: "com.android.settings:id/homepage_container" },
    { left: 48, top: 196, right: 696, bottom: 372 },
  ],
] as const)("XR tapAny reads visible rows in order: %j", (container, bounds) => {
  expect(select(true, container)?.bounds).toEqual(bounds);
});

test("non-XR selection retains hidden OK, leaf-container miss and smallest Sound row", () => {
  expect(select(false)?.["resource-id"]).toBe("com.android.systemui:id/button2");
  expect(select(false, { text: "Apps" })).toBeNull();
  expect(
    select(false, { elementId: "com.android.settings:id/homepage_container" })?.bounds,
  ).toEqual({ left: 48, top: 1252, right: 696, bottom: 1328 });
});

test("tapAny prepares the shared XR verdict before selecting an Apps owner row", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const detector = new FakeAndroidXrDetector(true);
  const adb = new FakeAdbClient();
  const service = new FakeCtrlProxy(timer);
  service.setSupportsNodeActionSelectors(true);
  service.setActionResult({ success: true, action: "click", totalTimeMs: 1 });
  const action = new TapAnyElement(
    { name: "fake", platform: "android", deviceId: "fake-xr-selection" },
    adb,
    {
      timer,
      xrDetector: detector,
      elementSelector: selector,
      accessibilityDetector: new FakeAccessibilityDetector(),
      accessibilityService: service,
    },
  );
  // Use authoritative window trees; JSON serialization duplicates the merged roots.
  const tree = { ...structuredClone(capture.viewHierarchy), hierarchy: {} };
  action.observedInteraction = runBlockWith(() =>
    recordObservationRead(
      buildObserveResult({
        viewHierarchy: tree,
        screenSize: capture.screenSize,
        updatedAt: 0,
        systemInsets: { top: 0, left: 0, right: 0, bottom: 0 },
      }),
    ),
  );
  action.testHooks.setRefreshViewHierarchy(async () => null);
  const result = await action.execute({ action: "tap", container: { text: "Apps" } });
  expect(result.success).toBe(true);
  expect(result.element?.bounds).toEqual({ left: 48, top: 548, right: 696, bottom: 724 });
  expect(detector.queries.length).toBeGreaterThan(0);
  expect(service.getNodeActionHistory()).toHaveLength(1);
  expect(adb.getAllCommands()).toHaveLength(0);
});

// Compose windows from the real Settings capture, keeping their node schema.
function settingsControl(text: string, top: number) {
  const source = new SearchableHierarchy()
    .project(hierarchy)
    .find((entry) => entry.displayedLabel === "Apps" && !entry.actionable)!.source;
  return {
    ...structuredClone(source),
    text,
    "resource-id": `com.android.settings:id/${text}`,
    clickable: true,
    bounds: { left: 48, top, right: 696, bottom: top + 100 },
  };
}

test.each([true, false])(
  "XR text fallback tries remaining scopes in reading order (owners=%s)",
  (clickable) => {
    const label = (top: number, width: number) => ({
      ...settingsControl("Apps", top),
      clickable: false,
      bounds: { left: 96, top, right: 96 + width, bottom: top + 1 },
    });
    const app = capture.viewHierarchy.windows!.find((window) => window.id === 38)!;
    const tree = {
      ...capture.viewHierarchy,
      hierarchy: {},
      windows: [
        {
          ...app,
          hierarchy: {
            node: [
              {
                ...settingsControl("Root", 48),
                clickable: false,
                bounds: { left: 0, top: 48, right: 744, bottom: 1328 },
                node: [
                  label(100, 1), // The smallest match wins initial container resolution and has no owner.
                  { ...settingsControl("Later", 600), clickable, node: [label(620, 3)] },
                  { ...settingsControl("Earlier", 300), clickable, node: [label(320, 4)] },
                ],
              },
            ],
          },
        },
      ],
    };
    const selected = select(true, { text: "Apps", selectionStrategy: "first" }, tree);
    if (clickable) {
      expect(selected?.text).toBe("Earlier");
      expect(selected?.bounds).toEqual({ left: 48, top: 300, right: 696, bottom: 400 });
    } else {
      expect(selected).toBeNull();
    }
  },
);

test.each([false, true])("topmost same-app window wins before reading order (XR=%s)", (xr) => {
  const app = capture.viewHierarchy.windows!.find((window) => window.id === 38)!;
  const tree = {
    ...capture.viewHierarchy,
    hierarchy: {},
    windows: [
      capture.viewHierarchy.windows!.find((window) => window.id === 1)!,
      { ...app, id: 90, windowLayer: 100, hierarchy: settingsControl("Dialog", 300) },
      { ...app, hierarchy: settingsControl("Background", 10) },
    ],
  };
  expect(select(xr, undefined, tree)?.text).toBe("Dialog");
});

test.each([
  ["non-leaf", 1, 100, false],
  ["over-quarter-window", 1, 400, true],
  ["full-window", 1, 100, true],
  ["too-deep", 4, 100, true],
  ["other-clickable-descendant", 2, 100, true],
  ["small-owner", 3, 100, true],
  ["quarter-window", 3, 332, true],
  ["viewport-fallback", 3, 100, true],
  ["viewport-fallback-oversized", 1, 3000, true],
] as const)("XR leaf fallback bounds its owner: %s", (kind, levels, height, leaf) => {
  const app = structuredClone(capture.viewHierarchy.windows!.find((window) => window.id === 38)!);
  const label = {
    ...settingsControl("Header", 300),
    clickable: false,
    bounds: { left: 48, top: 300, right: 68, bottom: 310 },
  };
  const bounds = { left: 0, top: 300, right: 744, bottom: 300 + height };
  // The non-leaf child is deliberately not clickable, so only the fallback could select the owner.
  let branch: ViewHierarchyNode = leaf
    ? label
    : { ...label, node: [{ ...settingsControl("Child", 300), clickable: false }] };
  for (let depth = 1; depth < levels; depth++) {
    branch = { ...settingsControl("", 300), clickable: false, bounds, node: [branch] };
  }
  const owner = {
    ...settingsControl("Owner", 300),
    bounds,
    node: [
      branch,
      // Nest the other control so the guard must inspect descendants, not just children.
      ...(kind === "other-clickable-descendant"
        ? [{ ...settingsControl("", 300), clickable: false, node: [settingsControl("Other", 350)] }]
        : []),
    ],
  };
  const root: ViewHierarchyNode = {
    ...settingsControl("", 0),
    clickable: false,
    node: [owner],
    bounds: kind === "full-window" ? bounds : { left: 0, top: 0, right: 744, bottom: 1328 },
  };
  if (kind.startsWith("viewport-fallback")) {
    delete root.bounds;
  }
  app.hierarchy = { node: [root] };
  app.bounds = kind === "full-window" ? bounds : app.bounds;
  const tree = { ...capture.viewHierarchy, hierarchy: {}, windows: [app] };
  const selected = select(true, { text: "Header" }, tree);
  if (kind === "small-owner" || kind === "quarter-window" || kind === "viewport-fallback") {
    expect(selected?.text).toBe("Owner");
    expect(selected?.bounds).toEqual(bounds);
  } else {
    expect(selected).toBeNull();
  }
  expect(select(false, { text: "Header" }, tree)).toBeNull();
});

// A live capture shares each window's root between the merged roots and `windows[i]`, and the
// hidden SystemUI chrome makes XR selection wrap the merged roots in a boundless root.
// JSON breaks that sharing, so relink it while keeping every SystemUI window.
function linkedCapture(ownerHeight?: number, ownerTop = 48, sectionText = ""): ViewHierarchyResult {
  const raw = structuredClone(capture.viewHierarchy);
  if (ownerHeight !== undefined) {
    const app = raw.windows!.find((window) => window.id === 38)!;
    const label = { ...settingsControl("Header", 300), clickable: false };
    label.bounds = { left: 96, top: 320, right: 187, bottom: 374 };
    const section = { ...settingsControl(sectionText, 300), clickable: false, node: [label] };
    section.bounds = { left: 0, top: 300, right: 744, bottom: 400 };
    const owner = { ...settingsControl("fragment_root", ownerTop), node: [section] };
    owner.bounds = { left: 0, top: ownerTop, right: 744, bottom: ownerTop + ownerHeight };
    app.hierarchy = { ...app.hierarchy!, node: [...childrenOf(app.hierarchy!), owner] };
  }
  // The serialized merged roots are an array under `hierarchy.node`.
  const roots = [raw.hierarchy.node!]
    .flat()
    .map(
      (root) =>
        raw.windows!.find((window) => window.id === nodeAttributes(root).windowId)?.hierarchy ??
        root,
    );
  return identifyObservedHierarchy(
    "android",
    { ...raw, hierarchy: { ...raw.hierarchy, node: { node: roots } } },
    "cached-ok",
    { timer: new FakeTimer() },
  ).hierarchy;
}

test("XR leaf fallback stops at the Settings window root, not the merged display wrapper", () => {
  const tree = linkedCapture(1280);
  expect(tree.windows!.filter((w) => w.packageName === "com.android.systemui").length).toBe(8);
  expect(select(true, { text: "Header" }, tree)).toBeNull();
  expect(select(false, { text: "Header" }, tree)).toBeNull();
});

test("XR leaf fallback refuses an owner over a quarter of the Settings pane", () => {
  // 744x400 is 31% of the 744x1280 pane but under a quarter of the 2560x2558 display.
  expect(select(true, { text: "Header" }, linkedCapture(400))).toBeNull();
});

test("XR leaf fallback still resolves the real Apps row in a linked capture", () => {
  expect(select(true, { text: "Apps" }, linkedCapture())?.bounds).toEqual({
    left: 48,
    top: 548,
    right: 696,
    bottom: 724,
  });
});

test("XR leaf fallback honours scrollableContainer", () => {
  const tree = linkedCapture(100, 300);
  expect(select(true, { text: "Header" }, tree)?.text).toBe("fragment_root");
  expect(select(true, { text: "Header" }, tree, true)).toBeNull();
  expect(select(true, { text: "Apps" }, linkedCapture(), true)?.bounds).toEqual({
    left: 48,
    top: 548,
    right: 696,
    bottom: 724,
  });
});

test("XR leaf fallback stays inside a nested selector's outer container", () => {
  const tree = linkedCapture(100, 300, "Section");
  expect(select(true, { text: "Header" }, tree)?.text).toBe("fragment_root");
  expect(select(true, { text: "Header", container: { text: "Section" } }, tree)).toBeNull();
});

test("a higher-layer dialog from another package wins over the Settings search bar", () => {
  const searchBar = { left: 48, top: 60, right: 568, bottom: 164 };
  const app = capture.viewHierarchy.windows!.find((window) => window.id === 38)!;
  const allow = {
    ...settingsControl("Allow", 600),
    "resource-id": "com.android.permissioncontroller:id/permission_allow_button",
  };
  const dialog = {
    ...app,
    id: 91,
    windowLayer: 1,
    packageName: "com.android.permissioncontroller",
    hierarchy: allow,
  };
  // Every captured window stays, so the search bar and the SystemUI chrome remain candidates.
  const tree = {
    ...capture.viewHierarchy,
    hierarchy: {},
    windows: [dialog, ...capture.viewHierarchy.windows!],
  };
  const selected = select(true, undefined, tree);
  expect(selected?.bounds).not.toEqual(searchBar);
  expect(selected?.["resource-id"]).toBe(allow["resource-id"]);
  // The dialog's absence restores the search bar, so the test exercises the ranking.
  expect(
    select(true, undefined, { ...tree, windows: capture.viewHierarchy.windows! })?.bounds,
  ).toEqual(searchBar);
});

test.each([
  ["beside Settings", { left: 800, top: 48, right: 1800, bottom: 1328 }, false],
  ["over Settings", { left: 0, top: 48, right: 744, bottom: 1328 }, true],
] as const)("another app's panel %s wins only when it overlaps", (_name, bounds, wins) => {
  const searchBar = { left: 48, top: 60, right: 568, bottom: 164 };
  const app = capture.viewHierarchy.windows!.find((window) => window.id === 38)!;
  const control = {
    ...settingsControl("Chrome", 600),
    "resource-id": "com.android.chrome:id/url_bar",
  };
  const panel = {
    ...app,
    id: 92,
    windowLayer: 1,
    packageName: "com.android.chrome",
    bounds,
    hierarchy: control,
  };
  const tree = {
    ...capture.viewHierarchy,
    hierarchy: {},
    windows: [panel, ...capture.viewHierarchy.windows!],
  };
  const selected = select(true, undefined, tree);
  if (wins) {
    expect(selected?.["resource-id"]).toBe(control["resource-id"]);
  } else {
    expect(selected?.bounds).toEqual(searchBar);
  }
});

test.each([
  ["IME", 2, false],
  ["application", 1, true],
] as const)("a package-less %s window ranks as a foreign window", (_name, type, wins) => {
  const searchBar = { left: 48, top: 60, right: 568, bottom: 164 };
  const app = capture.viewHierarchy.windows!.find((window) => window.id === 38)!;
  const key = { ...settingsControl("q", 600), "resource-id": "" };
  const window = { ...app, id: 93, type, windowLayer: 1, hierarchy: key };
  delete window.packageName;
  const tree = {
    ...capture.viewHierarchy,
    hierarchy: {},
    windows: [window, ...capture.viewHierarchy.windows!],
  };
  const selected = select(true, undefined, tree);
  if (wins) {
    expect(selected?.text).toBe("q");
  } else {
    expect(selected?.bounds).toEqual(searchBar);
  }
});

test("XR leaf fallback may promote to a nested selector's outer container when it is the row", () => {
  const tree = linkedCapture(100, 300);
  const selected = select(true, { text: "Header", container: { text: "fragment_root" } }, tree);
  expect(selected?.text).toBe("fragment_root");
  expect(selected?.bounds).toEqual({ left: 0, top: 300, right: 744, bottom: 400 });
});

test("tapAny asks the XR verdict for a capture without hidden SystemUI chrome", async () => {
  const ime: { viewHierarchy: ViewHierarchyResult } = JSON.parse(
    readFileSync(
      new URL(
        "../../fixtures/android-xr/observe-settings-search-ime-up-screensize-17881.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const detector = new FakeAndroidXrDetector(true);
  const taps: number[] = [];
  const action = new TapAnyElement(
    { name: "fake", platform: "android", deviceId: "fake-xr-no-chrome" },
    new FakeAdbClient(),
    {
      timer,
      xrDetector: detector,
      elementSelector: selector,
      accessibilityDetector: new FakeAccessibilityDetector(),
      // The fake tapper never routes, so every detector query comes from selection.
      androidTapper: {
        executeAndroidTap: async (_action, { x }) => {
          taps.push(x);
        },
        retryAndroidTapIfNoChange: async () => {},
      },
    },
  );
  action.observedInteraction = runBlockWith(() =>
    recordObservationRead(
      buildObserveResult({
        viewHierarchy: ime.viewHierarchy,
        screenSize: { width: 2560, height: 2558 },
        updatedAt: 0,
        systemInsets: { top: 0, left: 0, right: 0, bottom: 0 },
      }),
    ),
  );
  action.testHooks.setRefreshViewHierarchy(async () => null);
  const result = await action.execute({ action: "tap" });
  expect(result.success).toBe(true);
  expect(result.element?.["content-desc"]).toBe("Navigate up");
  expect(taps).toHaveLength(1);
  expect(detector.queries).toEqual(["fake-xr-no-chrome"]);
});
