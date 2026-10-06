import { describe, expect, test } from "bun:test";
import { CTRL_PROXY_PACKAGE } from "../../../src/ctrlProxy/constants";
import { overlayTapUnderSystemBar } from "../../../src/features/action/overlayTapUnderSystemBars";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";

// Geometry from the #10086 device run: 1080x2400, 136 px status bar, 63 px gesture bar.
const insets = { top: 136, bottom: 63, left: 0, right: 0 };
const fullScreen = { left: 0, top: 0, right: 1080, bottom: 2400 };

function capture(
  windows: NonNullable<ViewHierarchyResult["windows"]>,
  overrides: Partial<ViewHierarchyResult> = {},
): ViewHierarchyResult {
  return {
    packageName: "dev.jasonpearson.automobile.playground",
    screenWidth: 1080,
    screenHeight: 2400,
    systemInsets: insets,
    windows,
    hierarchy: { node: { bounds: fullScreen } },
    ...overrides,
  } as ViewHierarchyResult;
}

const ownOverlay = (bounds = fullScreen) => ({
  id: 2,
  type: 4,
  packageName: CTRL_PROXY_PACKAGE,
  bounds,
});

describe("overlayTapUnderSystemBar (#10086)", () => {
  test("a point in the navigation bar band under the fullscreen overlay is named", () => {
    expect(overlayTapUnderSystemBar(capture([ownOverlay()]), { x: 618, y: 2356 })).toBe(
      "navigation bar",
    );
  });

  test("a point in the status bar band under a full-height floating overlay is named", () => {
    const floating = ownOverlay({ left: 120, top: 0, right: 960, bottom: 2400 });
    expect(overlayTapUnderSystemBar(capture([floating]), { x: 370, y: 44 })).toBe("status bar");
  });

  test("the strip just above the navigation bar is reachable, the first bar pixel is not", () => {
    expect(overlayTapUnderSystemBar(capture([ownOverlay()]), { x: 618, y: 2336 })).toBeUndefined();
    expect(overlayTapUnderSystemBar(capture([ownOverlay()]), { x: 618, y: 2337 })).toBe(
      "navigation bar",
    );
  });

  test("a point inside the safe area is not flagged", () => {
    expect(overlayTapUnderSystemBar(capture([ownOverlay()]), { x: 500, y: 1200 })).toBeUndefined();
    expect(overlayTapUnderSystemBar(capture([ownOverlay()]), { x: 500, y: 136 })).toBeUndefined();
  });

  test("without an own overlay window covering the point nothing is judged", () => {
    expect(overlayTapUnderSystemBar(capture([]), { x: 618, y: 2356 })).toBeUndefined();
    const elsewhere = ownOverlay({ left: 0, top: 600, right: 1080, bottom: 900 });
    expect(overlayTapUnderSystemBar(capture([elsewhere]), { x: 618, y: 2356 })).toBeUndefined();
  });

  test("another package's overlay window and application windows are never judged", () => {
    const screenReader = {
      id: 3,
      type: 4,
      packageName: "com.example.screenreader",
      bounds: fullScreen,
    };
    const app = { id: 1, type: 1, packageName: CTRL_PROXY_PACKAGE, bounds: fullScreen };
    expect(overlayTapUnderSystemBar(capture([screenReader]), { x: 1, y: 2 })).toBeUndefined();
    expect(overlayTapUnderSystemBar(capture([app]), { x: 1, y: 2 })).toBeUndefined();
  });

  test("a capture without insets, screen height or hierarchy cannot prove a bar", () => {
    const noInsets = capture([ownOverlay()], { systemInsets: undefined });
    expect(overlayTapUnderSystemBar(noInsets, { x: 618, y: 2356 })).toBeUndefined();
    const noHeight = capture([ownOverlay()], { screenHeight: undefined });
    expect(overlayTapUnderSystemBar(noHeight, { x: 618, y: 2356 })).toBeUndefined();
    expect(overlayTapUnderSystemBar(undefined, { x: 1, y: 1 })).toBeUndefined();
  });
});
