import { expect, test } from "bun:test";
import { deviceFrameOrThrow } from "../../../../src/features/prototype/web/deviceFrames";
import { renderDeviceFrame, screenSize } from "../../../../src/features/prototype/web/webFrame";
import {
  el,
  type WebChild,
  type WebElement,
} from "../../../../src/features/prototype/web/webNodes";

const chrome = (root: WebChild, name: string): WebElement | undefined => {
  if (typeof root === "string") {
    return undefined;
  }
  return root.attrs["data-chrome"] === name
    ? root
    : root.children.map((child) => chrome(child, name)).find((found) => found !== undefined);
};
const frameOf = (id: string, orientation: "portrait" | "landscape") =>
  renderDeviceFrame(
    deviceFrameOrThrow(id),
    orientation,
    { dark: false, textColor: "#000" },
    el("div"),
  );

test("landscape swaps the screen's width and height", () => {
  const frame = deviceFrameOrThrow("pixel-9");
  expect(screenSize(frame, "landscape")).toEqual({ width: 923, height: 411 });
  expect(chrome(frameOf("pixel-9", "landscape"), "screen")?.style).toMatchObject({
    width: "923px",
    height: "411px",
  });
});

test("the cutout moves from the top edge to the left edge in landscape", () => {
  expect(chrome(frameOf("pixel-9", "portrait"), "cutout")?.style).toMatchObject({
    left: "193.5px",
    top: "12px",
  });
  expect(chrome(frameOf("pixel-9", "landscape"), "cutout")?.style).toMatchObject({
    left: "12px",
    top: "193.5px",
  });
});

test("safe areas follow the orientation", () => {
  expect(chrome(frameOf("iphone-16", "landscape"), "screen")?.style).toMatchObject({
    "--safe-top": "0px",
    "--safe-left": "59px",
  });
});

test("an iPhone hides its status bar in landscape; Android keeps it", () => {
  expect(chrome(frameOf("iphone-16", "landscape"), "statusBar")).toBeUndefined();
  expect(chrome(frameOf("pixel-9", "landscape"), "statusBar")).toBeDefined();
});

test("a frame without a navigation bar draws no handle", () => {
  expect(chrome(frameOf("iphone-se-3", "portrait"), "navBar")).toBeUndefined();
});
