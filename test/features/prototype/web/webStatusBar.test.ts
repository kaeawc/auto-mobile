import { expect, test } from "bun:test";
import { deviceFrameOrThrow } from "../../../../src/features/prototype/web/deviceFrames";
import {
  el,
  type WebChild,
  type WebElement,
} from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";
import {
  appTopColor,
  parseCssColor,
  renderStatusBar,
  statusBarContentFor,
} from "../../../../src/features/prototype/web/webStatusBar";

const find = (root: WebChild, match: (node: WebElement) => boolean): WebElement | undefined => {
  if (typeof root === "string") {
    return undefined;
  }
  return match(root)
    ? root
    : root.children.map((child) => find(child, match)).find((found) => found !== undefined);
};
const status = (root: WebChild, name: string) =>
  find(root, (node) => node.attrs["data-status"] === name);
const statusBarOf = (root: WebChild) =>
  find(root, (node) => node.attrs["data-chrome"] === "statusBar");

test("parses rgba, rgb and hex colours, and nothing else", () => {
  expect(parseCssColor("rgba(10,20,30,0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
  expect(parseCssColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
  expect(parseCssColor("#ff8000")).toEqual({ r: 255, g: 128, b: 0, a: 1 });
  expect(parseCssColor("var(--x)")).toBeUndefined();
  expect(parseCssColor(undefined)).toBeUndefined();
});

test("a light top colour takes dark content and a dark one light content", () => {
  expect(statusBarContentFor("rgba(255,255,255,1)", "light")).toBe("dark");
  expect(statusBarContentFor("#fef7ff", "light")).toBe("dark");
  expect(statusBarContentFor("rgba(20,18,24,1)", "dark")).toBe("light");
  expect(statusBarContentFor("#6750a4", "dark")).toBe("light");
  expect(statusBarContentFor(undefined, "light")).toBe("light");
});

test("the top colour is the innermost opaque full-width leading background, else the fallback", () => {
  const bar = el("div", { style: { "align-self": "stretch", "background-color": "#112233" } });
  const chip = el("div", { style: { "background-color": "#ffffff" } });
  const translucent = el("div", {
    style: { "align-self": "stretch", "background-color": "rgba(0,0,0,0.5)" },
  });
  expect(appTopColor(el("div", {}, [el("div", {}, [bar])]), "#fff")).toBe("#112233");
  expect(appTopColor(el("div", {}, [chip]), "#000")).toBe("#000");
  expect(appTopColor(el("div", {}, [translucent]), "#000")).toBe("#000");
  expect(appTopColor(el("div", { style: { "background-color": "#abcdef" } }), "#000")).toBe(
    "#abcdef",
  );
  // A dark header paints over its white root, so the header's colour wins.
  const root = el("div", { style: { width: "100%", "background-color": "#ffffff" } }, [bar]);
  expect(appTopColor(el("div", {}, [root]), "#000")).toBe("#112233");
});

test("the marks reflect the simulated device state", () => {
  const bar = renderStatusBar({
    frame: deviceFrameOrThrow("pixel-9"),
    width: 411,
    landscape: false,
    content: "dark",
    state: { clock: "12:30", batteryPercent: 42.4, wifi: false, cellularBars: 2 },
  });
  expect(status(bar, "clock")?.children).toEqual(["12:30"]);
  expect(status(bar, "battery")?.attrs["data-level"]).toBe("42");
  expect(status(bar, "wifi")?.attrs["data-level"]).toBe("off");
  expect(status(bar, "wifi")?.style.opacity).toBe("0.35");
  const cellular = status(bar, "cellular")!;
  expect(cellular.attrs["data-level"]).toBe("2");
  expect((cellular.children as WebElement[]).map((child) => child.style.opacity)).toEqual([
    "1",
    "1",
    "0.35",
    "0.35",
  ]);
});

test("the default state is fixed: 9:41, full battery, Wi-Fi and four bars", () => {
  const bar = renderStatusBar({
    frame: deviceFrameOrThrow("iphone-16"),
    width: 393,
    landscape: false,
    content: "light",
  });
  expect(status(bar, "clock")?.children).toEqual(["9:41"]);
  expect(status(bar, "battery")?.attrs["data-level"]).toBe("100");
  expect(status(bar, "wifi")?.attrs["data-level"]).toBe("on");
  expect(status(bar, "cellular")?.attrs["data-level"]).toBe("4");
  expect(bar.style.color).toBe("#ffffff");
});

test("an iPhone with an island centres each side in the ear beside it; Android pads the edges", () => {
  const ios = deviceFrameOrThrow("iphone-16");
  const iosBar = renderStatusBar({ frame: ios, width: 393, landscape: false, content: "dark" });
  const cutout = ios.cutout.type === "island" ? ios.cutout.widthDp : 0;
  const ear = `${Number(((393 - cutout) / 2).toFixed(3))}px`;
  for (const side of iosBar.children as WebElement[]) {
    expect(side.style).toMatchObject({ width: ear, "justify-content": "center" });
  }
  const androidBar = renderStatusBar({
    frame: deviceFrameOrThrow("pixel-9"),
    width: 411,
    landscape: false,
    content: "dark",
  });
  expect(androidBar.style.padding).toBe("0 16px");
  expect((androidBar.children[0] as WebElement).style).not.toHaveProperty("width");
});

const spec = (window: Record<string, unknown>, theme?: Record<string, unknown>) => ({
  id: "status",
  window: { placement: { type: "fullscreen" }, ...window },
  ...(theme ? { theme } : {}),
  root: { type: "column", id: "root", children: [{ type: "text", id: "t", text: "Hi" }] },
});

test("a still follows the theme: dark content on a light screen, light on a dark one", () => {
  for (const frame of ["pixel-9", "iphone-16"]) {
    const light = renderPrototypeStill(spec({}, { mode: "light" }), { frame });
    expect(statusBarOf(light.element)?.attrs["data-status-content"]).toBe("dark");
    const dark = renderPrototypeStill(spec({}, { mode: "dark" }), { frame });
    expect(statusBarOf(dark.element)?.attrs["data-status-content"]).toBe("light");
  }
});

test("window.statusBar light or dark wins over the top colour; auto follows it", () => {
  const forced = renderPrototypeStill(spec({ statusBar: "light" }, { mode: "light" }));
  expect(statusBarOf(forced.element)?.attrs["data-status-content"]).toBe("light");
  const auto = renderPrototypeStill(spec({ statusBar: "auto" }, { mode: "dark" }));
  expect(statusBarOf(auto.element)?.attrs["data-status-content"]).toBe("light");
});

test("a dark header on a light root takes light content in a still", () => {
  const still = renderPrototypeStill({
    id: "header",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "column",
      style: { width: "fill", height: "fill", background: "#ffffff" },
      children: [{ type: "topAppBar", title: "Inbox", style: { background: "#1d1b20" } }],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("light");
});

test("a sheet leaves the status area on the screen background", () => {
  const still = renderPrototypeStill({
    id: "sheet",
    window: { placement: { type: "sheet", edge: "bottom", height: 200 } },
    theme: { mode: "light" },
    root: {
      type: "column",
      style: { width: "fill", background: "#1d1b20" },
      children: [{ type: "text", text: "Sheet" }],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("dark");
});
