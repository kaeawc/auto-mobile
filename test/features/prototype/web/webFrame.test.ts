import { expect, test } from "bun:test";
import { deviceFrameOrThrow } from "../../../../src/features/prototype/web/deviceFrames";
import {
  renderChromelessScreen,
  renderDeviceFrame,
  screenSize,
} from "../../../../src/features/prototype/web/webFrame";
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
    { dark: false, textColor: "#000", background: "#fff" },
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

test("button navigation draws three visible marks", () => {
  const nav = chrome(frameOf("small-phone", "portrait"), "navBar")!;
  const buttons = nav.children[0] as WebElement;
  expect(buttons.attrs["data-nav"]).toBe("buttons");
  expect(buttons.children).toHaveLength(3);
  for (const mark of buttons.children as WebElement[]) {
    expect(mark.style.border).toBe("2px solid #000000");
  }
});

test("landscape button navigation sits on the right edge the frame reserves; gestures stay at the bottom", () => {
  const side = chrome(frameOf("small-phone", "landscape"), "navBar")!;
  expect(side.style).toMatchObject({ right: "0", top: "0", width: "48px" });
  expect(side.style).not.toHaveProperty("height");
  const bottom = chrome(frameOf("iphone-16", "landscape"), "navBar")!;
  expect(bottom.style).toMatchObject({ bottom: "0", left: "0" });
});

test("a chromeless screen is the screen alone: no bezel, bars, radius, insets or background", () => {
  const screen = renderChromelessScreen(
    deviceFrameOrThrow("pixel-9"),
    "portrait",
    { dark: false, textColor: "#000", background: "#fff" },
    el("div"),
  );
  expect(screen.attrs["data-chrome"]).toBe("screen");
  expect(screen.children).toHaveLength(1);
  expect(chrome(screen, "statusBar")).toBeUndefined();
  expect(chrome(screen, "navBar")).toBeUndefined();
  expect(screen.style).toMatchObject({
    width: "411px",
    height: "923px",
    "border-radius": "0px",
    "background-color": "transparent",
    "--safe-top": "0px",
    "--safe-bottom": "0px",
  });
});
