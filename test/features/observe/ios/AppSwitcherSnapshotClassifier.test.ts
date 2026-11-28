import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseXcuiDebugLine } from "../../../../src/features/watch/WatchXcuiDebugDescription";
import { parseBounds } from "../../../../src/utils/bounds";
import { isIosAppSwitcherVisible } from "../../../../src/features/observe/ios/AppSwitcherSnapshotClassifier";
import { convertToViewHierarchyResult } from "../../../../src/features/observe/ios/IosHierarchyConverter";
import type {
  IosRunnerWireHierarchy,
  IosRunnerWireNode,
} from "../../../../src/features/observe/ios/types";

function snapshot(
  cardWidth = 275,
  contentWidth = 402,
  cardValue = "Active",
): IosRunnerWireHierarchy {
  return {
    packageName: "com.apple.springboard",
    updatedAt: 1,
    hierarchy: {
      node: [
        {
          "resource-id": "AppSwitcherContentView",
          bounds: [0, 0, contentWidth, 874],
          node: {
            "resource-id": "card:com.apple.Preferences:sceneID:com.apple.Preferences-default",
            bounds: [63, 128, 63 + cardWidth, 727],
            value: cardValue,
          },
        },
      ],
    },
  };
}

const FIXTURES = path.join(import.meta.dir, "../../../fixtures/ios-app-switcher");

/** The identified elements of an iPad device capture (#19456), as flat runner wire nodes. */
function captured(name: string): IosRunnerWireNode[] {
  return readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8")
    .split("\n")
    .map(parseXcuiDebugLine)
    .flatMap((line) =>
      line?.identifier && line.frame
        ? [
            {
              "resource-id": line.identifier,
              bounds: [line.frame.left, line.frame.top, line.frame.right, line.frame.bottom] as [
                number,
                number,
                number,
                number,
              ],
              ...(line.value === undefined ? {} : { value: line.value }),
            },
          ]
        : [],
    );
}

function wire(nodes: IosRunnerWireNode[]): IosRunnerWireHierarchy {
  return { packageName: "com.apple.springboard", updatedAt: 1, hierarchy: { node: nodes } };
}

function cards(nodes: IosRunnerWireNode[]): IosRunnerWireNode[] {
  return nodes.filter((node) => String(node["resource-id"]).startsWith("card:"));
}

describe("iOS App Switcher snapshot classifier", () => {
  test("Stage Manager strip cards on screen are not the switcher (#19457)", () => {
    const nodes = captured("ios27_2-ipad-stage-manager-strip-no-switcher");
    // On the device every card, the inset stage card included, reports Active.
    expect(cards(nodes).length).toBeGreaterThan(1);
    expect(cards(nodes).every((node) => node.value === "Active")).toBe(true);
    const hierarchy = wire(nodes);
    expect(isIosAppSwitcherVisible(hierarchy.hierarchy)).toBe(false);
    expect(isIosAppSwitcherVisible(convertToViewHierarchyResult(hierarchy).hierarchy)).toBe(false);
    const strip = new Set(
      cards(nodes).filter((node) => {
        const bounds = parseBounds(node.bounds);
        return bounds !== null && bounds.right - bounds.left < 100;
      }),
    );
    expect(strip.size).toBe(2);
    const withoutStrip = nodes.filter((node) => !strip.has(node));
    expect(isIosAppSwitcherVisible(wire(withoutStrip).hierarchy)).toBe(true);
  });

  test("the switcher opened in Stage Manager is still detected", () => {
    const nodes = captured("ios27_2-ipad-stage-manager-switcher-open");
    expect(cards(nodes).every((node) => node.value === "Active")).toBe(true);
    const hierarchy = wire(nodes);
    expect(isIosAppSwitcherVisible(hierarchy.hierarchy)).toBe(true);
    expect(isIosAppSwitcherVisible(convertToViewHierarchyResult(hierarchy).hierarchy)).toBe(true);
  });

  test("captured switchers read the same without card values, as the runner sends them", () => {
    for (const name of [
      "ios27_2-ipad-stage-manager-strip-no-switcher",
      "ios27_2-ipad-stage-manager-switcher-open",
    ]) {
      const withValues = isIosAppSwitcherVisible(wire(captured(name)).hierarchy);
      const bare = captured(name).map(({ value: _value, ...node }) => node);
      expect(isIosAppSwitcherVisible(wire(bare).hierarchy)).toBe(withValues);
    }
  });

  test("recognizes a scaled card in raw wire and converted hierarchies", () => {
    const hierarchy = snapshot();
    expect(isIosAppSwitcherVisible(hierarchy.hierarchy)).toBe(true);
    expect(isIosAppSwitcherVisible(convertToViewHierarchyResult(hierarchy).hierarchy)).toBe(true);
  });

  test("a scaled card that reports Stashed (iPad window parked by Home) is not visible", () => {
    const hierarchy = snapshot(275, 402, "Stashed");
    expect(isIosAppSwitcherVisible(hierarchy.hierarchy)).toBe(false);
    expect(isIosAppSwitcherVisible(convertToViewHierarchyResult(hierarchy).hierarchy)).toBe(false);
  });

  test("home without cards and an empty hierarchy are not the switcher", () => {
    expect(isIosAppSwitcherVisible({ className: "XCUIApplication" })).toBe(false);
    expect(isIosAppSwitcherVisible(undefined)).toBe(false);
  });

  test("a card without a content view is not visible, matching Swift", () => {
    expect(
      isIosAppSwitcherVisible({
        resourceId: "card:com.apple.Preferences",
        bounds: { left: 63, top: 128, right: 338, bottom: 727 },
      }),
    ).toBe(false);
  });

  test.each([361.8, 402])("a full-size or exactly 90 percent card (%s) is not visible", (width) => {
    expect(isIosAppSwitcherVisible(snapshot(width).hierarchy)).toBe(false);
  });

  test.each([0, -1])("requires positive card and content dimensions (%s)", (size) => {
    expect(isIosAppSwitcherVisible(snapshot(size).hierarchy)).toBe(false);
    expect(isIosAppSwitcherVisible(snapshot(275, size).hierarchy)).toBe(false);
    const hierarchy = snapshot();
    hierarchy.hierarchy.node = [
      { "resource-id": "AppSwitcherContentView", bounds: [0, 0, 402, size] },
      { "resource-id": "card:app", bounds: [0, 0, 275, 599] },
    ];
    expect(isIosAppSwitcherVisible(hierarchy.hierarchy)).toBe(false);
    hierarchy.hierarchy.node[0].bounds = [0, 0, 402, 874];
    hierarchy.hierarchy.node[1].bounds = [0, 0, 275, size];
    expect(isIosAppSwitcherVisible(hierarchy.hierarchy)).toBe(false);
  });

  test("any positive content view can establish the scaled-card comparison", () => {
    const hierarchy = snapshot();
    hierarchy.hierarchy.node = [
      { resourceId: "AppSwitcherContentView", bounds: [0, 0, 100, 874] },
      ...[hierarchy.hierarchy.node].flat().filter((node) => node !== undefined),
    ];
    expect(isIosAppSwitcherVisible(hierarchy.hierarchy)).toBe(true);
  });
});
