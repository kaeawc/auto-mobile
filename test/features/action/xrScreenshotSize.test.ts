import { expect, test } from "bun:test";
import { xrScreenshotSize } from "../../../src/features/xr/xrPanelSpace";
import { xrBackStack } from "../../helpers/xrHeadset";

test("XR screenshot image dimensions win over screen and fullscreen task bounds", () => {
  expect(
    xrScreenshotSize({
      screenSize: { width: 1080, height: 608 },
      screenshotImageSize: { width: 1600, height: 1600 },
      backStack: xrBackStack(),
    }),
  ).toEqual({ width: 1600, height: 1600 });
});

test("XR uses the largest fullscreen task including System UI regardless of task order", () => {
  const backStack = xrBackStack();
  backStack.tasks.reverse();
  expect(xrScreenshotSize({ screenSize: { width: 1080, height: 608 }, backStack })).toEqual({
    width: 2558,
    height: 2558,
  });
  expect(xrScreenshotSize({ screenSize: { width: 2560, height: 2558 }, backStack })).toEqual({
    width: 2558,
    height: 2558,
  });
});

test("XR preserves the screen-size fallback without valid fullscreen bounds", () => {
  const screenSize = { width: 1080, height: 608 };
  expect(xrScreenshotSize({ screenSize })).toEqual({ width: 608, height: 608 });
  const backStack = xrBackStack();
  backStack.tasks = backStack.tasks.filter((task) => task.windowingMode !== "fullscreen");
  backStack.tasks.push(
    { id: 20, windowingMode: "fullscreen" },
    { id: 21, windowingMode: "fullscreen", bounds: { left: 0, top: 0, right: NaN, bottom: 2558 } },
    { id: 22, windowingMode: "fullscreen", bounds: { left: 5, top: 0, right: 0, bottom: 2558 } },
  );
  expect(xrScreenshotSize({ screenSize, backStack })).toEqual({ width: 608, height: 608 });
});
