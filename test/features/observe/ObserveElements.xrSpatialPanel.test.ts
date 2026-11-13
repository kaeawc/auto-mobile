import { getSearchableEntries } from "../../../src/features/observe/output/elementProvenance";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { SafeAreaAuditor } from "../../../src/features/observe/audits/SafeAreaAuditor";
import { expect, test } from "bun:test";
import { SingleDisplayEnrichStage } from "../../../src/features/observe/SingleDisplayEnrichStage";
import { CachedAndroidXrDisplaySize } from "../../../src/features/observe/android/AndroidXrDisplaySize";
import type { SingleDisplayRun } from "../../../src/features/observe/singleDisplayRun";
import { ObservedAndroidDisplayCache } from "../../../src/features/observe/ObservationDisplay";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { ObserveElementsBuilder } from "../../../src/features/observe/ObserveElementsBuilder";
import { sanitizeObserveResult } from "../../../src/features/observe/output/ObserveResultOutput";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { spatialPanelObservation } from "../../helpers/xrSpatialPanelFixture";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildObserveResult } from "../../helpers/observeFixture";

function unused(): never {
  throw new Error("Unexpected stage dependency");
}

const panelCaptures = [
  [false, 93],
  ["host-missing", 105],
  [true, 98],
] as const;

test.each(panelCaptures)(
  "XR panel coordinates are declared (capture=%s)",
  async (capture, windowId) => {
    const observation = spatialPanelObservation(capture);
    const raw = structuredClone(observation.viewHierarchy);
    await enrich(observation, true);
    expect(observation).toMatchObject({
      xrPanelSpace: { windowId, bounds: { left: 0, top: 0, right: 2768, bottom: 2400 } },
    });
    const appRows = observation.elements!.text.filter((row) =>
      ["Settings", "Item 1", "Notifications"].includes(row.text ?? ""),
    );
    expect(appRows.length).toBeGreaterThan(0);
    expect(appRows.every((row) => row.boundsSpace === "panel")).toBe(true);
    const captions = observation.elements!.clickable.filter((row) =>
      ["Minimize the current window", "Close"].includes(row["content-desc"] ?? ""),
    );
    expect(captions.length).toBeGreaterThan(0);
    expect(captions.every((row) => row.boundsSpace === "window")).toBe(true);
    const elements = Object.values(observation.elements!).flat();
    expect(elements.every((row) => row.boundsSpace !== undefined)).toBe(true);
    const statusRows = elements.filter((row) => row.bounds.top === 0 && row.bounds.bottom === 48);
    expect(statusRows.length).toBeGreaterThan(0);
    expect(statusRows.every((row) => row.boundsSpace === "window")).toBe(true);
    expect(observation.viewHierarchy).toEqual(raw);
  },
);

for (const project of ["full", "skeleton"] as const) {
  test.each(panelCaptures)(
    `XR panel coordinates survive ${project} projection (capture=%s)`,
    async (capture, windowId) => {
      const observation = spatialPanelObservation(capture);
      const raw = structuredClone(observation.viewHierarchy);
      await enrich(observation, true);
      const output = sanitizeObserveResult(observation, {
        dropElements: false,
        compact: true,
        project,
      });
      expect(output).toMatchObject({ xrPanelSpace: { windowId, bounds: [0, 0, 2768, 2400] } });
      if (project === "skeleton") {
        const rows = [...output.skeleton!, ...(output.context ?? [])];
        expect(rows.find((row) => row.label === "Settings")).toMatchObject({
          boundsSpace: "panel",
        });
        expect(rows.find((row) => row.label === "Close")).toMatchObject({ boundsSpace: "window" });
        expect(rows.every((row) => row.boundsSpace !== undefined)).toBe(true);
      }
      expect(observation.viewHierarchy).toEqual(raw);
    },
  );
}

test("XR skeleton sanitization is deterministic across repeated calls", async () => {
  const observation = spatialPanelObservation("host-missing");
  await enrich(observation, true);
  const config = { dropElements: false, compact: true, project: "skeleton" } as const;
  const output = sanitizeObserveResult(observation, config);
  expect(sanitizeObserveResult(observation, config)).toEqual(output);
});

test("XR skeleton sanitization preserves its input", async () => {
  const observation = spatialPanelObservation("host-missing");
  await enrich(observation, true);
  const original = structuredClone(observation);
  sanitizeObserveResult(observation, { dropElements: false, compact: true, project: "skeleton" });
  expect(observation).toEqual(original);
});

test("non-XR full and skeleton output stay byte-identical", () => {
  const observation = spatialPanelObservation();
  observation.elements = new ObserveElementsBuilder().build(
    observation.viewHierarchy!,
    "android",
    false,
    observation,
  );
  for (const [project, digest] of [
    ["full", "5076eef69a06ddd1de991084ab8bb3b37ec2bce8697b0d8cc546966965d3e779"],
    ["skeleton", "a870556b6f4c3ea679320ebdef816263ba97a442feb096f0891be2566f904593"],
  ] as const) {
    const serialized = JSON.stringify(
      sanitizeObserveResult(observation, { dropElements: false, compact: true, project }),
    );
    expect(serialized).not.toContain("boundsSpace");
    expect(serialized).not.toContain("xrPanelSpace");
    expect(createHash("sha256").update(serialized).digest("hex")).toBe(digest);
  }
});

test("a panel without a window id cannot declare a coordinate space", async () => {
  const observation = spatialPanelObservation();
  delete observation.viewHierarchy!.windows!.find((window) => window.id === 93)!.id;
  await enrich(observation, true);
  expect(observation.xrPanelSpace).toBeUndefined();
  expect(JSON.stringify(observation.elements)).not.toContain("boundsSpace");
});

test("task-aligned stock XR app has no coordinate-space fields", async () => {
  const capture: Pick<ViewHierarchyResult, "windows"> = JSON.parse(
    readFileSync(
      new URL("../../fixtures/android-xr/observe-settings-panel-children.json", import.meta.url),
      "utf8",
    ),
  );
  const observation = buildObserveResult({
    updatedAt: 0,
    screenSize: { width: 2560, height: 2558 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: { hierarchy: {}, windows: capture.windows },
    activeWindow: { appId: "com.android.settings", activityName: ".Settings", layoutSeqSum: 0 },
    backStack: {
      currentTaskId: 1,
      depth: 1,
      activities: [],
      tasks: [
        {
          id: 1,
          packageName: "com.android.settings",
          bounds: { left: 0, top: 48, right: 2048, bottom: 1328 },
        },
      ],
    },
  });
  await enrich(observation, true);
  const output = JSON.stringify(
    sanitizeObserveResult(observation, { dropElements: false, compact: true, project: "skeleton" }),
  );
  expect(output).toContain("Connected devices");
  expect(output).not.toContain("boundsSpace");
  expect(output).not.toContain("xrPanelSpace");
});
async function enrich(result: ObserveResult, xr: boolean, platform: "android" | "ios" = "android") {
  const timer = new FakeTimer();
  const detector = new FakeAndroidXrDetector(xr);
  const device = {
    name: "fake",
    deviceId: "fixture-xr-output",
    platform,
    formFactor: "phone",
  } as const;
  const xrDisplaySize = new CachedAndroidXrDisplaySize({
    device: () => device,
    xrDetector: detector,
    hierarchyCollector: unused,
    readDisplaySize: async () => result.screenSize,
  });
  await xrDisplaySize.prime(result, result.viewHierarchy!);
  const stage = new SingleDisplayEnrichStage({
    device: () => device,
    isAndroidXr: () => xrDisplaySize.isXrCached(),
    timer: () => timer,
    platformTraits: unused,
    screenshotRecorder: unused,
    pathProtection: unused,
    performanceAuditor: unused,
    accessibilityAuditor: unused,
    accessibilityStateDetector: unused,
    predictiveUIState: unused,
    safeAreaAuditor: () => new SafeAreaAuditor(),
    elementsBuilder: () => new ObserveElementsBuilder(),
    screenRound: unused,
    deferredBackStackDisplays: unused,
    stampScreenSizeUnits: () => {},
    processRecomposition: async () => {},
    captureSettledScreenshot: async () => {},
  });
  const run: SingleDisplayRun = {
    options: undefined,
    perf: new NoOpPerformanceTracker(),
    queryOptions: undefined,
    skipWaitForFresh: true,
    minTimestamp: 0,
    signal: undefined,
    skipBackStack: false,
    observerMode: true,
    preserveDisplayState: false,
    displayRequest: undefined,
    androidDisplayCache: new ObservedAndroidDisplayCache(timer),
    screenshotMode: "none",
    iosLockState: undefined,
    observedAndroid: undefined,
    explicitlyRouted: false,
    requestedPanel: undefined,
    requestedDisplayId: undefined,
    result,
    startTime: 0,
    captureStart: { revision: 0, identityRevision: 0 },
    routedAggregateSecondary: false,
    cacheGeneration: 0,
  };
  const enriched = stage.enrichSingleDisplay(run);
  expect(result.elements).toBeDefined();
  await enriched;
  return detector;
}
const hidden = [
  "Cancel",
  "Confirm",
  "Recents",
  "Clear all",
  "Launcher",
  "Notifications",
  "Passthrough Window",
  "Recenter",
  "Unbind Controllers",
];

test.each([false, "host-missing"] as const)(
  "XR elements, visibleTexts and skeleton omit hidden SystemUI while preserving raw action nodes (capture=%s)",
  async (capture) => {
    const observation = spatialPanelObservation(capture);
    const raw = structuredClone(observation.viewHierarchy);
    const detector = await enrich(observation, true);
    expect(detector.queries).toEqual(["fixture-xr-output"]);
    const entries = getSearchableEntries(observation.elements!)!;
    expect(entries.every((entry, index) => entry.index === index)).toBe(true);
    const elements = JSON.stringify(observation.elements);
    const visibleTexts = observation.elements!.text.map(
      (element) => element.text ?? element["content-desc"],
    );
    const output = sanitizeObserveResult(observation, {
      dropElements: true,
      compact: true,
      project: "skeleton",
    });
    const skeleton = JSON.stringify(output);
    for (const text of hidden) {
      expect(elements.includes(`"${text}"`)).toBe(false);
      expect(visibleTexts).not.toContain(text);
      expect(skeleton.includes(text)).toBe(false);
    }
    for (const text of ["Settings", "Item 1"]) {
      expect(elements).toContain(text);
      expect(skeleton).toContain(text);
    }
    expect(observation.viewHierarchy).toEqual(raw);
    expect(JSON.stringify(raw)).toContain("Unbind Controllers");
  },
);

test("non-XR output keeps the captured hidden SystemUI labels", async () => {
  const observation = spatialPanelObservation();
  await enrich(observation, false);
  expect(JSON.stringify(observation.elements)).toContain("Unbind Controllers");
});

test("XR home space without an app window keeps its hidden chrome", async () => {
  const observation = spatialPanelObservation();
  const hierarchy = observation.viewHierarchy!;
  hierarchy.windows = hierarchy.windows!.filter((window) =>
    window.packageName?.startsWith("com.android.systemui"),
  );
  hierarchy.packageName = "com.android.systemui.xrhomeenv";
  observation.activeWindow = { ...observation.activeWindow!, appId: hierarchy.packageName };
  // Use the captured SystemUI window roots; remove the captured app from both representations.
  hierarchy.hierarchy = {
    node: {
      node: hierarchy.windows.flatMap((window) => (window.hierarchy ? [window.hierarchy] : [])),
    },
  };
  await enrich(observation, true);
  expect(JSON.stringify(observation.elements)).toContain("Unbind Controllers");
});

test("iOS output never asks the XR detector", async () => {
  const observation = spatialPanelObservation();
  const detector = await enrich(observation, true, "ios");
  expect(detector.queries).toEqual([]);
  expect(JSON.stringify(observation.elements)).toContain("Unbind Controllers");
});

test.each([true, undefined, "false"])(
  "only boolean false hides SystemUI (flag=%s)",
  async (flag) => {
    const observation = spatialPanelObservation();
    const matches = new SearchableHierarchy()
      .project(observation.viewHierarchy!)
      .filter((entry) => entry.properties.text === "Confirm");
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      Object.assign(match.source, { "visible-to-user": flag });
    }
    await enrich(observation, true);
    expect(observation.elements!.text.some((element) => element.text === "Confirm")).toBe(true);
  },
);

test("a package-owned SystemUI window without an id cannot hide app nodes", async () => {
  const observation = spatialPanelObservation();
  const hierarchy = observation.viewHierarchy!;
  for (const window of hierarchy.windows!) {
    if (window.packageName?.startsWith("com.android.systemui")) {
      delete window.id;
    }
  }
  for (const entry of new SearchableHierarchy().project(hierarchy)) {
    if (entry.properties.text === "Settings") {
      Object.assign(entry.source, { "visible-to-user": false });
    }
  }
  await enrich(observation, true);
  expect(observation.elements!.text.some((element) => element.text === "Settings")).toBe(true);
  expect(observation.elements!.text.some((element) => element.text === "Confirm")).toBe(false);
});

test("XR filtering uses the current task when activeWindow is absent", async () => {
  const observation = spatialPanelObservation("host-missing");
  delete observation.activeWindow;
  // Task order is not foreground evidence.
  observation.backStack!.tasks.reverse();
  await enrich(observation, true);
  expect(JSON.stringify(observation.elements)).not.toContain('"Confirm"');
  expect(JSON.stringify(observation.elements)).toContain('"Settings"');
  expect(observation.xrPanelSpace?.windowId).toBe(105);
});

test("XR output preserves visible captions", async () => {
  const observation = spatialPanelObservation();
  await enrich(observation, true);
  const output = JSON.stringify(
    sanitizeObserveResult(observation, { dropElements: true, compact: true, project: "skeleton" }),
  );
  for (const text of ["XrDogfood", "Minimize the current window", "Close"]) {
    expect(output).toContain(text);
  }
});

test("unfocused XR settings keeps its visible Notifications label while hiding SystemUI chrome", async () => {
  const observation = spatialPanelObservation(true);
  await enrich(observation, true);
  const output = JSON.stringify(
    sanitizeObserveResult(observation, { dropElements: true, compact: true, project: "skeleton" }),
  );
  for (const text of hidden.filter((text) => text !== "Notifications")) {
    expect(output).not.toContain(text);
  }
  for (const text of ["Settings", "Notifications", "XR Dogfood"]) {
    expect(output).toContain(text);
  }
});

test.each(["no-foreground", "systemui-active", "non-XR"] as const)(
  "a background app panel does not enable XR filtering (%s)",
  async (kind) => {
    const observation = spatialPanelObservation("host-missing");
    if (kind === "no-foreground") {
      delete observation.activeWindow;
      delete observation.backStack;
    } else if (kind === "systemui-active") {
      observation.activeWindow!.appId = "com.android.systemui.xrhomeenv";
    }
    await enrich(observation, kind !== "non-XR");
    expect(JSON.stringify(observation.elements)).toContain("Unbind Controllers");
    expect(observation.xrPanelSpace).toBeUndefined();
    expect(JSON.stringify(observation.elements)).not.toContain("boundsSpace");
  },
);

test("any app application window enables XR filtering even without a window tree", async () => {
  const observation = spatialPanelObservation("host-missing");
  delete observation.viewHierarchy!.windows!.find((window) => window.id === 105)!.hierarchy;
  await enrich(observation, true);
  expect(JSON.stringify(observation.elements)).not.toContain('"Confirm"');
  expect(JSON.stringify(observation.elements)).toContain('"Settings"');
});

test("hierarchy identity alone does not enable foreground XR filtering", () => {
  const observation = spatialPanelObservation();
  observation.elements = new ObserveElementsBuilder().build(
    observation.viewHierarchy!,
    "android",
    true,
  );
  expect(JSON.stringify(observation.elements)).toContain("Unbind Controllers");
});

test("a cached XR clone restores provenance and keeps the live skeleton labels (#18084)", async () => {
  const observation = spatialPanelObservation();
  // A text descendant that exactly fills its clickable owner keeps its label only
  // when recollection reproduces the live XR visibility policy.
  const entries = new SearchableHierarchy().project(observation.viewHierarchy!);
  const leaves = entries.filter((entry) => entry.properties.text === "Item 1");
  expect(leaves.length).toBeGreaterThan(0);
  for (const leaf of leaves) {
    let owner = leaf.parentIndex === undefined ? undefined : entries[leaf.parentIndex];
    while (owner && !owner.affordances.includes("tap")) {
      owner = owner.parentIndex === undefined ? undefined : entries[owner.parentIndex];
    }
    expect(owner).toBeDefined();
    Object.assign(leaf.source, { bounds: structuredClone(owner!.source.bounds) });
  }
  await enrich(observation, true);
  const options = { dropElements: true, compact: true, project: "skeleton" } as const;
  // Cache returns are structured clones, which drop the collector's provenance.
  const clone = structuredClone(observation);
  expect(getSearchableEntries(clone.elements!)).toBeUndefined();
  const live = sanitizeObserveResult(observation, options);
  const cloned = sanitizeObserveResult(clone, options);
  expect(JSON.stringify(live)).toContain('"label":"Item 1"');
  expect(cloned).toEqual(live);
});

const SWITCH_ID = "s2-54a37556722ca76a";

async function switchScrollSkeleton(mutate?: (observation: ObserveResult) => void) {
  const observation = spatialPanelObservation("switch-scroll");
  mutate?.(observation);
  await enrich(observation, true);
  return sanitizeObserveResult(observation, {
    dropElements: false,
    compact: true,
    project: "skeleton",
  });
}

test("captured unlabelled Compose Switch takes its preceding sibling text (#17955)", async () => {
  const output = await switchScrollSkeleton();
  expect(output.skeleton!.find((row) => row.elementId === SWITCH_ID)).toEqual({
    bounds: [32, 65, 136, 161],
    affordances: ["tap", "toggle"],
    elementId: SWITCH_ID,
    label: "XrPanel title",
    checked: false,
    boundsSpace: "panel",
  });
  // The text itself stays readable context; it is not consumed by the toggle.
  expect(output.context!.find((row) => row.label === "XrPanel title")).toBeDefined();
});

test("captured Switch stays unlabelled when no text precedes it (#17955)", async () => {
  const output = await switchScrollSkeleton((observation) => {
    // Drop the captured title text only; every other captured value is unchanged.
    const strip = (node: unknown): void => {
      if (!node || typeof node !== "object") {
        return;
      }
      const record = node as Record<string, unknown>;
      if (record.text === "XrPanel title") {
        delete record.text;
      }
      Object.values(record).forEach(strip);
    };
    strip(observation.viewHierarchy);
  });
  const row = output.skeleton!.find((entry) => entry.elementId === SWITCH_ID);
  expect(row).toBeDefined();
  expect(row).not.toHaveProperty("label");
});

const SHARED_SWITCH_ID = "dev.jasonpearson.xrpanel:id/switch";

/** Repeat the captured title + Switch pair beside the original; both Switches take one resource id. */
function repeatTitledSwitch(observation: ObserveResult): void {
  const shift = (node: unknown): void => {
    if (!node || typeof node !== "object") {
      return;
    }
    const bounds = (node as { bounds?: { left: number; right: number } }).bounds;
    if (bounds) {
      bounds.left += 600;
      bounds.right += 600;
    }
    Object.values(node).forEach(shift);
  };
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") {
      return;
    }
    const record = node as Record<string, unknown>;
    const children = Array.isArray(record.node) ? (record.node as Record<string, unknown>[]) : [];
    const at = children.findIndex((child) => child.text === "XrPanel title");
    if (at >= 0) {
      children[at + 1]["resource-id"] = SHARED_SWITCH_ID;
      const pair = structuredClone(children.slice(at, at + 2));
      shift(pair);
      children.splice(at + 2, 0, ...pair);
      return;
    }
    Object.values(record).forEach(visit);
  };
  // The capture serializes the panel twice (merged tree and its window); repeat it in both.
  visit(observation.viewHierarchy);
}

test("two captured Switches sharing an id keep their sibling labels and indexes (#17955)", async () => {
  const output = await switchScrollSkeleton(repeatTitledSwitch);
  const rows = output.skeleton!.filter((row) => row.elementId === SHARED_SWITCH_ID);
  expect(rows.map(({ label, index, bounds }) => ({ label, index, bounds }))).toEqual([
    { label: "XrPanel title", index: 0, bounds: [32, 65, 136, 161] },
    { label: "XrPanel title", index: 1, bounds: [632, 65, 736, 161] },
  ]);
});

/** The skeleton row label and every searchable copy's label for the captured Switch. */
async function switchLabels(mutate: (observation: ObserveResult) => void) {
  const observation = spatialPanelObservation("switch-scroll");
  mutate(observation);
  await enrich(observation, true);
  const output = sanitizeObserveResult(observation, {
    dropElements: false,
    compact: true,
    project: "skeleton",
  });
  const switches = getSearchableEntries(observation.elements!)!.filter(
    (entry) => entry.properties["view-id"] === SWITCH_ID,
  );
  expect(switches.length).toBeGreaterThan(0);
  return {
    skeleton: output.skeleton!.find((row) => row.elementId === SWITCH_ID)?.label,
    searchable: switches.map((entry) => entry.displayedLabel),
  };
}

/** Put each captured Switch inside a bounds-less copy of its captured parent container. */
function wrapSwitchInBoundlessParent(observation: ObserveResult): void {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") {
      return;
    }
    const record = node as Record<string, unknown>;
    const children = Array.isArray(record.node) ? (record.node as Record<string, unknown>[]) : [];
    const at = children.findIndex((child) => child["view-id"] === SWITCH_ID);
    if (at >= 0) {
      const wrapper: Record<string, unknown> = { ...record };
      delete wrapper.node;
      delete wrapper.bounds;
      delete wrapper["view-id"];
      children[at] = { ...wrapper, node: [children[at]] };
      return;
    }
    Object.values(record).forEach(visit);
  };
  visit(observation.viewHierarchy);
}

test("a Switch inside a bounds-less wrapper takes the same sibling label in both projections (#18253)", async () => {
  const labels = await switchLabels(wrapSwitchInBoundlessParent);
  expect(labels.skeleton).toBe("XrPanel title");
  expect(labels.searchable).toEqual(labels.searchable.map(() => "XrPanel title"));
});

test("a windows-only capture keeps sibling labels within one window root in both projections (#18253)", async () => {
  // The captured panel window lists the title and Switch as separate top-level roots.
  const labels = await switchLabels((observation) => {
    delete (observation.viewHierarchy as { hierarchy?: unknown }).hierarchy;
  });
  expect(labels.skeleton).toBeUndefined();
  expect(labels.searchable).toEqual(labels.searchable.map(() => undefined));
});
