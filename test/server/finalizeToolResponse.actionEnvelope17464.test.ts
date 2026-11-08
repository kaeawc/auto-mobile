import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { createStructuredToolResponse, getStructuredPayload } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import { DefaultObserveElementCollector } from "../../src/features/observe/ObserveElementCollector";
import type { ObserveResult } from "../../src/models/ObserveResult";
import type { LayoutWarning } from "../../src/models/ObservationInsets";

// Pins the default (`project: skeleton`) action envelope against the noise the
// #17464 dogfood run captured on 0.0.90 (a regression of #11637). The capture is
// a real Settings screen whose `layoutWarnings` are all the
// `interaction-in-system-gesture-region` / `severity: info` kind the issue lists.
const capture: ObserveResult = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/android-settings/open-by-default-radio-rows.observe.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

type Mutable = Record<string, unknown>;
type Payload = Record<string, any>;

function visit(node: unknown, fn: (n: Mutable) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n) => visit(n, fn));
  } else if (node && typeof node === "object") {
    fn(node as Mutable);
    Object.values(node).forEach((n) => visit(n, fn));
  }
}

function observation(mutate?: (copy: ObserveResult) => void): ObserveResult {
  const copy: ObserveResult = structuredClone(capture);
  mutate?.(copy);
  return {
    ...copy,
    elements: new DefaultObserveElementCollector().collect(copy.viewHierarchy!, "android"),
  };
}

/** Settings rows moved (the Wi-Fi toggle in the issue): every row warning moves with them. */
function rowsMovedAndCheckboxToggled(copy: ObserveResult): void {
  visit(copy.viewHierarchy, (n) => {
    if (n["resource-id"] === "android:id/checkbox" && n.checked === "true") {
      n.checked = "false";
    }
  });
  // The capture stores compacted `[l, t, r, b]` bounds; shift each row down by one row height.
  const warnings = copy.layoutWarnings!.warnings.map((warning): LayoutWarning => {
    const [left, top, right, bottom]: number[] = Object.values(warning.element.bounds);
    return {
      ...warning,
      element: {
        ...warning.element,
        bounds: { left, top: top + 155, right, bottom: bottom + 155 },
      },
    };
  });
  // Keyboard edge keys (the issue's first sendKeys) appear as new warnings.
  const key = (text: string, left: number): LayoutWarning => ({
    type: "interaction-in-system-gesture-region",
    severity: "info",
    element: { contentDesc: text, bounds: { left, top: 1900, right: left + 98, bottom: 2050 } },
    categories: ["interaction"],
    insetTypes: ["systemGestures"],
    sides: [left === 0 ? "left" : "right"],
    overflowPx: left === 0 ? { left: 20 } : { right: 20 },
    insetPx: left === 0 ? { left: 78 } : { right: 78 },
    overlapPercent: 20,
    confidence: "medium",
  });
  copy.layoutWarnings = {
    scope: "full",
    warnings: [...warnings, key("q", 0), key("p", 982), key("a", 0), key("l", 982)],
  };
}

function makeStore() {
  const map = new Map<string, ObserveResult>();
  const metadata = new Map<string, { deviceId: string; blocks: Record<string, unknown> }>();
  return {
    get: (u: string) => map.get(u),
    set: (u: string, o: ObserveResult) => void map.set(u, o),
    getActionMetadata: (u: string, deviceId: string) =>
      metadata.get(u)?.deviceId === deviceId ? metadata.get(u)?.blocks : undefined,
    setActionMetadata: (u: string, deviceId: string, blocks: Record<string, unknown>) =>
      void metadata.set(u, { deviceId, blocks }),
  };
}

function act(
  name: string,
  extra: Record<string, unknown> = {},
  args?: Record<string, unknown>,
  mutateNext: (copy: ObserveResult) => void = rowsMovedAndCheckboxToggled,
): Payload {
  const store = makeStore();
  finalizeToolResponse(createStructuredToolResponse(observation()), {
    name: "observe",
    sessionUuid: "s1",
    baselineStore: store,
  });
  return getStructuredPayload<Payload>(
    finalizeToolResponse(
      createStructuredToolResponse({
        success: true,
        ...extra,
        observation: observation(mutateNext),
      }),
      {
        name,
        args,
        defaultsToSkeletonObservation: true,
        sessionUuid: "s1",
        baselineStore: store,
      },
    ),
  )!;
}

const ACTION_TOOLS = ["tapOn", "sendKeys", "launchApp"] as const;

describe("#17464 default action envelope", () => {
  let diffEnabled: boolean;
  beforeEach(() => {
    diffEnabled = serverConfig.isActionsDiffObserveEnabled();
  });
  afterEach(() => serverConfig.setActionsDiffObserveEnabled(diffEnabled));

  for (const name of ACTION_TOOLS) {
    test(`${name}: a skeleton diff carries no layoutWarnings and no added/removed`, () => {
      serverConfig.setActionsDiffObserveEnabled(true);
      const diff = act(name).observation;

      expect(diff.isDiff).toBe(true);
      expect(diff.skeleton.length).toBeGreaterThan(0);
      expect(diff.fields?.layoutWarnings).toBeUndefined();
      expect("layoutWarnings" in diff).toBe(false);
      expect("added" in diff).toBe(false);
      expect("removed" in diff).toBe(false);
      expect(diff.changed.map((c: any) => c.selector.elementId)).toContain("android:id/checkbox");
    });

    test(`${name}: a full skeleton observation carries no layoutWarnings`, () => {
      serverConfig.setActionsDiffObserveEnabled(false);
      const served = act(name).observation;

      expect(served.isDiff).toBeUndefined();
      expect(served.skeleton.length).toBeGreaterThan(0);
      expect("layoutWarnings" in served).toBe(false);
    });
  }

  test('project:"full" still opts back into layoutWarnings on a diff', () => {
    serverConfig.setActionsDiffObserveEnabled(true);
    const diff = act("tapOn", {}, { project: "full" }).observation;

    expect(diff.isDiff).toBe(true);
    expect(diff.fields.layoutWarnings.to.warnings.length).toBeGreaterThan(0);
  });

  test("tapOn: the matched node is not repeated as element when read from two captures", () => {
    const matched = {
      "resource-id": "android:id/checkbox",
      class: "android.widget.CheckBox",
      checkable: "true",
      checked: "true",
      bounds: { left: 53, top: 1089, right: 137, bottom: 1173 },
      actions: ["ACTION_CLICK", "ACTION_FOCUS"],
    };
    // The tap target re-read after stabilisation: same node, different volatile attributes.
    const element = {
      ...matched,
      "view-id": "s2-b8b4bf93ebc4b052",
      focused: "true",
      hierarchyDepth: 9,
      actions: ["ACTION_FOCUS", "ACTION_CLICK", "ACTION_ACCESSIBILITY_FOCUS"],
    };
    const out = act("tapOn", {
      element,
      selectedElement: {
        matchedElement: matched,
        text: "",
        resourceId: "android:id/checkbox",
        bounds: { left: 53, top: 1089, right: 137, bottom: 1173, centerX: 95, centerY: 1131 },
      },
    });

    expect(out.selectedElement.matchedElement).toEqual(matched);
    expect(out.element).toBeUndefined();
  });

  test("tapOn: a promoted tap target that is a different node keeps element", () => {
    const matched = {
      "resource-id": "android:id/title",
      text: "In your browser",
      bounds: { left: 168, top: 1089, right: 600, bottom: 1173 },
    };
    const row = {
      class: "android.widget.LinearLayout",
      clickable: "true",
      bounds: { left: 0, top: 1054, right: 1080, bottom: 1209 },
    };
    const out = act("tapOn", { element: row, selectedElement: { matchedElement: matched } });

    expect(out.element).toEqual(row);
  });

  describe("#17515 warning-only change after a screen-changed effect", () => {
    const screenChanged = { effect: { screenChanged: true } };
    const warnings = (copy: ObserveResult): LayoutWarning[] => copy.layoutWarnings!.warnings;
    const statusBarIcon: LayoutWarning = {
      type: "important-content-under-inset",
      severity: "warning",
      element: {
        contentDesc: "Messages notification:",
        bounds: { left: 80, top: 20, right: 120, bottom: 60 },
      },
      categories: ["interaction"],
      insetTypes: ["systemBars"],
      sides: ["top"],
      overflowPx: { top: 40 },
      insetPx: { top: 142 },
      overlapPercent: 100,
      confidence: "high",
    };
    const keyboardKey: LayoutWarning = {
      ...statusBarIcon,
      type: "interaction-in-system-gesture-region",
      severity: "info",
      element: { contentDesc: "q", bounds: { left: 0, top: 1900, right: 98, bottom: 2050 } },
      insetTypes: ["systemGestures"],
      sides: ["left"],
      overflowPx: { left: 20 },
      insetPx: { left: 78 },
      overlapPercent: 20,
      confidence: "medium",
    };

    function envelope(
      name: string,
      mutateNext: (copy: ObserveResult) => void,
      args?: Record<string, unknown>,
    ) {
      serverConfig.setActionsDiffObserveEnabled(true);
      return act(name, screenChanged, args, mutateNext);
    }

    for (const name of ACTION_TOOLS) {
      test(`${name}: a material warning change stays a diff without layoutWarnings`, () => {
        const out = envelope(name, (copy) => warnings(copy).push(keyboardKey));

        expect(out.observationDiff).toMatchObject({ mode: "diff", reason: "diff_emitted" });
        expect(out.observation.isDiff).toBe(true);
        expect(out.observation.fields?.layoutWarnings).toBeUndefined();
      });

      test(`${name}: s2- view id churn alone falls back to the full envelope`, () => {
        const out = envelope(name, (copy) =>
          warnings(copy).forEach((warning, index) => {
            warning.element.viewId = `s2-${index.toString(16).padStart(16, "0")}`;
          }),
        );

        expect(out.observationDiff).toMatchObject({ mode: "full", reason: "screen_changed" });
        expect(out.observation.isDiff).toBeUndefined();
      });

      test(`${name}: a SystemUI status-bar warning alone falls back to the full envelope`, () => {
        const out = envelope(name, (copy) => warnings(copy).push(statusBarIcon));

        expect(out.observationDiff).toMatchObject({ mode: "full", reason: "screen_changed" });
      });

      test(`${name}: confidence-only churn falls back to the full envelope`, () => {
        const out = envelope(name, (copy) =>
          warnings(copy).forEach((warning) => {
            warning.confidence = warning.confidence === "high" ? "medium" : "high";
          }),
        );

        expect(out.observationDiff).toMatchObject({ mode: "full", reason: "screen_changed" });
      });
    }

    test('project:"full" still reports the warning change in the diff', () => {
      const out = envelope("tapOn", (copy) => warnings(copy).push(keyboardKey), {
        project: "full",
      });

      expect(out.observationDiff).toMatchObject({ mode: "diff", reason: "diff_emitted" });
      expect(
        out.observation.fields.layoutWarnings.to.warnings.map(
          (w: LayoutWarning) => w.element.contentDesc,
        ),
      ).toContain("q");
    });
  });
});
