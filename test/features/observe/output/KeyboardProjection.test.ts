import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import type { ViewHierarchyNode } from "../../../../src/models/ViewHierarchyResult";
import { DefaultObserveElementCollector } from "../../../../src/features/observe/ObserveElementCollector";
import { sanitizeObserveResult } from "../../../../src/features/observe/output/ObserveResultOutput";

function observation(platform: "android" | "ios" = "android", keyboard = true): ObserveResult {
  const node = (text: string): ViewHierarchyNode => ({
    $: { text, clickable: true, bounds: { left: 0, top: 0, right: 100, bottom: 100 } },
  });
  const viewHierarchy = {
    hierarchy: {
      node: {
        $: {},
        node: [
          node("SAVE"),
          ...(keyboard
            ? [
                {
                  $: { extras: { "automobile:imePackage": "example.keyboard" } },
                  node: [
                    node("Q"),
                    node("Next"),
                    {
                      $: {
                        text: "Suggestion",
                        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
                      },
                    },
                  ],
                },
              ]
            : []),
          node("App control"),
        ],
      },
    },
  };
  return {
    updatedAt: 1,
    screenSize: { width: 100, height: 200 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy,
    elements: new DefaultObserveElementCollector().collect(viewHierarchy, platform),
  };
}

describe("Android keyboard output projection", () => {
  test("reports a captured keyboard even without accessible keys", () => {
    const source = observation();
    source.viewHierarchy!.hierarchy.node!.node![1].node = [];
    source.elements = new DefaultObserveElementCollector().collect(
      source.viewHierarchy!,
      "android",
    );
    const result = sanitizeObserveResult(source, { dropElements: true, project: "skeleton" });
    expect(result.keyboard).toEqual({ visible: true, package: "example.keyboard" });
    expect(JSON.stringify(source.elements)).not.toContain("keyboard");
  });
  test("folds keyboard descendants while retaining overlapping app controls", () => {
    const source = observation();
    const before = JSON.stringify(source);
    const result = sanitizeObserveResult(source, { dropElements: true, project: "skeleton" });
    expect(result.skeleton?.map((entry) => entry.label)).toEqual(["SAVE", "App control"]);
    expect(result.keyboard).toEqual({ visible: true, package: "example.keyboard" });
    expect(result.context).toBeUndefined();
    expect(JSON.stringify(source)).toBe(before);
  });

  test("full output retains every keyboard node", () => {
    const source = observation();
    const result = sanitizeObserveResult(source, { dropElements: false, project: "full" });
    expect(result.elements?.clickable.map((entry) => entry.text)).toEqual([
      "SAVE",
      "Q",
      "Next",
      "App control",
    ]);
    expect(result.viewHierarchy).toBeDefined();
    expect(result.keyboard).toBeUndefined();
  });

  test("does not invent visibility without keyboard capture evidence", () => {
    expect(
      sanitizeObserveResult(observation("android", false), {
        dropElements: true,
        project: "skeleton",
      }).keyboard,
    ).toBeUndefined();
  });

  test("does not fold iOS nodes carrying Android extras", () => {
    const result = sanitizeObserveResult(observation("ios"), {
      dropElements: true,
      project: "skeleton",
    });
    expect(result.skeleton?.map((entry) => entry.label)).toContain("Q");
    expect(result.keyboard).toBeUndefined();
  });
});
