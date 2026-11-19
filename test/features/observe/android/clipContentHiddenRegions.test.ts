import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { clipContentHiddenRegions } from "../../../../src/features/observe/android/clipContentHiddenRegions";
import type {
  ContentHiddenRegion,
  ViewHierarchyResult,
  ViewHierarchyWindowInfo,
} from "../../../../src/models/ViewHierarchyResult";
import { observeResultFromJsonText } from "../../../helpers/observeFixture";

// Real CtrlProxy observations from an API 36 emulator (Pixel 9, 1080x2424), captured for #3183.
const directory = "../../../fixtures/observe-output/compose-interop-3183/";

function loadHierarchy(name: string): ViewHierarchyResult {
  const observation = observeResultFromJsonText(
    readFileSync(new URL(`${directory}${name}.json`, import.meta.url), "utf8"),
    name,
  );
  if (!observation.viewHierarchy) {
    throw new Error(`${name} has no view hierarchy`);
  }
  return observation.viewHierarchy;
}

function clipFixture(name: string): ContentHiddenRegion[] | undefined {
  const hierarchy = loadHierarchy(name);
  return clipContentHiddenRegions(hierarchy.contentHiddenRegions, hierarchy);
}

const region = (
  left: number,
  top: number,
  right: number,
  bottom: number,
  areaPercent = 0,
): ContentHiddenRegion => ({
  bounds: { left, top, right, bottom },
  reason: "compose-interop-no-hide-descendants",
  areaPercent,
});

const appWindow: ViewHierarchyWindowInfo = {
  id: 1,
  type: 1,
  bounds: { left: 0, top: 0, right: 1000, bottom: 2000 },
};

describe("clipContentHiddenRegions (#18675)", () => {
  test("Contacts ComposeView-in-Views region is clipped to its Compose host, inside the screen", () => {
    // The runner reported [0,478,1080,2486]: past the 2424px screen and over the bottom navigation
    // bar, because the flagged Compose child is larger than its ComposeView host [0,478,1080,2150].
    expect(clipFixture("composeview-in-views-contacts")).toEqual([region(0, 478, 1080, 2150, 68)]);
  });

  test("a region already inside its host, window and screen keeps its bounds (Pointer Probe)", () => {
    expect(clipFixture("androidview-in-compose-pointer-probe")).toEqual([
      region(42, 732, 1038, 1867, 43),
    ]);
  });

  test("no regions stays undefined", () => {
    expect(clipFixture("androidview-recyclerview-in-compose-shared-row-id")).toBeUndefined();
  });

  test("clips to the screen and the visible window when no Compose host is in the tree", () => {
    const window = { ...appWindow, bounds: { left: 0, top: 100, right: 1000, bottom: 1800 } };
    expect(
      clipContentHiddenRegions([region(-50, 0, 1100, 2400, 99)], {
        screenWidth: 1000,
        screenHeight: 2000,
        windows: [window],
      }),
    ).toEqual([region(0, 100, 1000, 1800, 85)]);
  });

  test("drops a region that clipping leaves at or under the 25% reporting threshold", () => {
    const host = {
      class: "androidx.compose.ui.platform.ComposeView",
      bounds: { left: 0, top: 0, right: 1000, bottom: 500 },
    };
    expect(
      clipContentHiddenRegions([region(0, 0, 1000, 1500, 75)], {
        screenWidth: 1000,
        screenHeight: 2000,
        windows: [appWindow],
        hierarchy: { node: [host] },
      }),
    ).toBeUndefined();
  });

  test("clips to the owning host, not a larger sibling host the child overflows into", () => {
    const composeHost = (top: number, bottom: number) => ({
      class: "androidx.compose.ui.platform.ComposeView",
      bounds: { left: 0, top, right: 1000, bottom },
    });
    expect(
      clipContentHiddenRegions([region(0, 0, 1000, 2000, 100)], {
        screenWidth: 1000,
        screenHeight: 2000,
        windows: [appWindow],
        hierarchy: { node: [composeHost(0, 600), composeHost(600, 2000)] },
      }),
    ).toEqual([region(0, 0, 1000, 600, 30)]);
  });

  test("picks the window after the host clip, so a split-screen neighbour cannot erase it", () => {
    const window = (id: number, top: number, bottom: number): ViewHierarchyWindowInfo => ({
      id,
      type: 1,
      bounds: { left: 0, top, right: 1000, bottom },
    });
    expect(
      clipContentHiddenRegions([region(0, 0, 1000, 2000, 100)], {
        screenWidth: 1000,
        screenHeight: 2000,
        windows: [window(1, 0, 600), window(2, 600, 2000)],
        hierarchy: {
          node: [
            {
              class: "androidx.compose.ui.platform.ComposeView",
              bounds: { left: 0, top: 0, right: 1000, bottom: 600 },
            },
          ],
        },
      }),
    ).toEqual([region(0, 0, 1000, 600, 30)]);
  });

  test("drops a region entirely off screen", () => {
    expect(
      clipContentHiddenRegions([region(0, 2100, 1000, 2900, 40)], {
        screenWidth: 1000,
        screenHeight: 2000,
      }),
    ).toBeUndefined();
  });

  test("keeps regions unchanged when there is nothing to clip against", () => {
    const regions = [region(0, 0, 1000, 3000, 80)];
    expect(clipContentHiddenRegions(regions, {})).toEqual(regions);
  });
});
