import { expect, test } from "bun:test";
import { deviceFrameOrThrow } from "../../../../src/features/prototype/web/deviceFrames";
import {
  frameOrientations,
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

test("iOS gestures draw the home indicator; Android draws the navigation handle", () => {
  const ios = chrome(frameOf("iphone-16", "portrait"), "navBar")!.children[0] as WebElement;
  expect(ios.attrs["data-nav"]).toBe("homeIndicator");
  expect(ios.style).toMatchObject({ width: "134px", height: "5px" });
  const android = chrome(frameOf("pixel-9", "portrait"), "navBar")!.children[0] as WebElement;
  expect(android.attrs["data-nav"]).toBe("handle");
  expect(android.style).toMatchObject({ width: "108px", height: "4px" });
});

test("the status bar content follows the option, else the dark flag", () => {
  const dark = renderDeviceFrame(
    deviceFrameOrThrow("pixel-9"),
    "portrait",
    { dark: true, textColor: "#fff", background: "#000" },
    el("div"),
  );
  expect(chrome(dark, "statusBar")?.attrs["data-status-content"]).toBe("light");
  const forced = renderDeviceFrame(
    deviceFrameOrThrow("pixel-9"),
    "portrait",
    { dark: true, textColor: "#fff", background: "#000", statusBarContent: "dark" },
    el("div"),
  );
  expect(chrome(forced, "statusBar")?.attrs["data-status-content"]).toBe("dark");
  expect(chrome(forced, "statusBar")?.style.color).toBe("#000000");
});

test("the island and the punch hole draw as a pill and a circle", () => {
  const island = chrome(frameOf("iphone-16", "portrait"), "cutout")!.style;
  expect(parseFloat(island.width!)).toBeGreaterThan(parseFloat(island.height!));
  expect(island["border-radius"]).toBe(`${parseFloat(island.height!) / 2}px`);
  const hole = chrome(frameOf("pixel-9", "portrait"), "cutout")!.style;
  expect(hole).toMatchObject({ width: "24px", height: "24px", "border-radius": "12px" });
});

test("a watch is portrait only, a TV and a car landscape only, a phone or tablet both (#16446)", () => {
  const orientations = (id: string) => frameOrientations(deviceFrameOrThrow(id));
  expect(orientations("wearos-small-round")).toEqual(["portrait"]);
  expect(orientations("apple-watch")).toEqual(["portrait"]);
  expect(orientations("android-tv-1080p")).toEqual(["landscape"]);
  expect(orientations("apple-tv")).toEqual(["landscape"]);
  expect(orientations("car-1024p-landscape")).toEqual(["landscape"]);
  expect(orientations("pixel-9")).toEqual(["portrait", "landscape"]);
  expect(orientations("ipad-10")).toEqual(["portrait", "landscape"]);
});

test("a round mask clips the screen and bezel to a circle; Apple Watch keeps its corner radius", () => {
  const round = frameOf("wearos-small-round", "portrait");
  expect(round.attrs["data-mask"]).toBe("round");
  expect(round.style["border-radius"]).toBe("50%");
  expect(chrome(round, "screen")?.style["border-radius"]).toBe("50%");
  const watch = frameOf("apple-watch", "portrait");
  expect(watch.attrs["data-mask"]).toBeUndefined();
  expect(chrome(watch, "screen")?.style["border-radius"]).toBe("42px");
});

test("watches and TVs draw no status or navigation bar; a car draws both", () => {
  for (const [id, orientation] of [
    ["wearos-small-round", "portrait"],
    ["apple-watch", "portrait"],
    ["android-tv-1080p", "landscape"],
    ["apple-tv", "landscape"],
  ] as const) {
    const frame = frameOf(id, orientation);
    expect(chrome(frame, "statusBar")).toBeUndefined();
    expect(chrome(frame, "navBar")).toBeUndefined();
  }
  const car = frameOf("car-1024p-landscape", "landscape");
  expect(chrome(car, "screen")?.style).toMatchObject({ width: "1024px", height: "768px" });
  expect(chrome(car, "statusBar")).toBeDefined();
  // The head unit's bar runs along the bottom, not down the side.
  expect(chrome(car, "navBar")?.style).toMatchObject({ bottom: "0", height: "64px" });
});

test("a TV's landscape screen is its 1080p panel at its density", () => {
  expect(screenSize(deviceFrameOrThrow("android-tv-1080p"), "landscape")).toEqual({
    width: 960,
    height: 540,
  });
  expect(screenSize(deviceFrameOrThrow("apple-tv"), "landscape")).toEqual({
    width: 1920,
    height: 1080,
  });
});
