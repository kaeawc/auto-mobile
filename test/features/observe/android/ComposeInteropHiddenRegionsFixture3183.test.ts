import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import { observeResultFromJsonText } from "../../../helpers/observeFixture";

// Real CtrlProxy observations from an API 36 emulator (Pixel 9, 1080x2424), captured for #3183.
const directory = "../../../fixtures/observe-output/compose-interop-3183/";

function load(name: string): ObserveResult {
  return observeResultFromJsonText(
    readFileSync(new URL(`${directory}${name}.json`, import.meta.url), "utf8"),
    name,
  );
}

/** Captures carry array bounds, which the static `ElementBounds` type does not express. */
function regionsOf(observation: ObserveResult): unknown {
  return observation.viewHierarchy?.contentHiddenRegions;
}

/** Every `class` value anywhere in the captured tree. */
function classNames(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    node.forEach((child) => classNames(child, found));
  } else if (node !== null && typeof node === "object") {
    Object.entries(node).forEach(([key, value]) => {
      if (key === "class" && typeof value === "string") {
        found.add(value);
      }
      classNames(value, found);
    });
  }
  return found;
}

describe("Compose interop hidden-region samples (#3183)", () => {
  test("ComposeView inside a View host (Contacts) flags the Compose area", () => {
    const observation = load("composeview-in-views-contacts");

    expect(classNames(observation.viewHierarchy?.hierarchy)).toContain(
      "androidx.compose.ui.platform.ComposeView",
    );
    expect(regionsOf(observation)).toEqual([
      {
        bounds: [0, 478, 1080, 2486],
        reason: "compose-interop-no-hide-descendants",
        areaPercent: 82,
      },
    ]);
  });

  test("AndroidView inside Compose (Pointer Probe) flags the interop area", () => {
    const observation = load("androidview-in-compose-pointer-probe");

    expect(classNames(observation.viewHierarchy?.hierarchy)).toContain(
      "androidx.compose.ui.viewinterop.ViewFactoryHolder",
    );
    expect(regionsOf(observation)).toEqual([
      {
        bounds: [42, 732, 1038, 1867],
        reason: "compose-interop-no-hide-descendants",
        areaPercent: 43,
      },
    ]);
  });

  test("AndroidView hosting a RecyclerView inside Compose (Shared Row Id) flags nothing", () => {
    const observation = load("androidview-recyclerview-in-compose-shared-row-id");
    const classes = classNames(observation.viewHierarchy?.hierarchy);

    expect(classes).toContain("androidx.compose.ui.viewinterop.ViewFactoryHolder");
    expect(classes).toContain("androidx.recyclerview.widget.RecyclerView");
    expect(regionsOf(observation)).toBeUndefined();
  });
});
