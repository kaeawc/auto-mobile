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

test("a root padded by the top safe area keeps its own colour behind the status bar", () => {
  const still = renderPrototypeStill({
    id: "padded",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "column",
      style: { width: "fill", height: "fill", background: "#ffffff" },
      safeAreaPadding: { edges: ["top"], types: ["systemBars"] },
      children: [{ type: "topAppBar", title: "Inbox", style: { background: "#1d1b20" } }],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("dark");
});

test("in a box the last stretching child paints over its siblings, so its colour wins", () => {
  const fill = (color: string, extra: Record<string, string> = {}) =>
    el("div", {
      style: { "justify-self": "stretch", width: "100%", "background-color": color, ...extra },
    });
  const box = (children: WebElement[]) =>
    el(
      "div",
      { style: { display: "grid", "grid-template-areas": '"cell"', width: "100%" } },
      children,
    );
  expect(appTopColor(box([fill("#000000"), fill("#ffffff")]), "#777777")).toBe("#ffffff");
  // A later child that does not span the screen does not hide the full-width one.
  const chip = el("div", { style: { "background-color": "#ff0000" } });
  expect(appTopColor(box([fill("#000000"), chip]), "#777777")).toBe("#000000");
  // A fully transparent later child paints nothing.
  expect(appTopColor(box([fill("#000000"), fill("#ffffff", { opacity: "0" })]), "#777777")).toBe(
    "#000000",
  );
  // A later full-fill child with no background of its own lets the earlier one show.
  const clear = el("div", { style: { "justify-self": "stretch", width: "100%" } });
  expect(appTopColor(box([fill("#000000"), clear]), "#777777")).toBe("#000000");
  // A bottom-aligned child does not reach the top, so the earlier full-fill one still shows there.
  const bottomBox = el(
    "div",
    {
      style: {
        display: "grid",
        "grid-template-areas": '"cell"',
        "align-items": "end",
        width: "100%",
      },
    },
    [fill("#000000", { "align-self": "stretch", height: "100%" }), fill("#ffffff")],
  );
  expect(appTopColor(bottomBox, "#777777")).toBe("#000000");
  // A column still follows its leading child.
  const column = el("div", { style: { display: "flex", width: "100%" } }, [
    fill("#000000"),
    fill("#ffffff"),
  ]);
  expect(appTopColor(column, "#777777")).toBe("#000000");
});

test("element opacity multiplies down the walk: transparent subtrees and faded backgrounds are skipped", () => {
  const black = (style: Record<string, string>, children: WebElement[] = []) =>
    el("div", { style: { width: "100%", "background-color": "#000000", ...style } }, children);
  expect(appTopColor(el("div", {}, [black({ opacity: "0" })]), "#ffffff")).toBe("#ffffff");
  expect(appTopColor(el("div", {}, [black({ opacity: "0.5" })]), "#ffffff")).toBe("#ffffff");
  // An ancestor's opacity applies to every descendant.
  const faded = el("div", { style: { width: "100%", opacity: "0.5" } }, [black({})]);
  expect(appTopColor(el("div", {}, [faded]), "#ffffff")).toBe("#ffffff");
  const hidden = el("div", { style: { width: "100%", opacity: "0" } }, [black({})]);
  expect(appTopColor(el("div", {}, [hidden]), "#ffffff")).toBe("#ffffff");
  expect(appTopColor(el("div", {}, [black({ opacity: "1" })]), "#ffffff")).toBe("#000000");
});

test("a fullscreen box's last full-fill child sets the status bar content in a still", () => {
  const still = renderPrototypeStill({
    id: "box",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "dark" },
    root: {
      type: "box",
      style: { width: "fill", height: "fill" },
      children: [
        { type: "column", style: { width: "fill", height: "fill", background: "#000000" } },
        { type: "column", style: { width: "fill", height: "fill", background: "#ffffff" } },
      ],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("dark");
});

test("a bottom-aligned footer in a fullscreen box leaves the full-fill colour behind the status bar", () => {
  const still = renderPrototypeStill({
    id: "footer",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "box",
      style: { width: "fill", height: "fill", alignment: "bottomStart" },
      children: [
        { type: "column", style: { width: "fill", height: "fill", background: "#000000" } },
        { type: "column", style: { width: "fill", height: { dp: 80 }, background: "#ffffff" } },
        { type: "column", style: { width: "fill", height: "fill" } },
      ],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("light");
});

test("a narrow full-height child in a fullscreen box leaves the full-fill colour behind the status bar", () => {
  const still = renderPrototypeStill({
    id: "rail",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "box",
      style: { width: "fill", height: "fill" },
      children: [
        { type: "column", style: { width: "fill", height: "fill", background: "#000000" } },
        { type: "column", style: { width: { dp: 20 }, height: "fill", background: "#ffffff" } },
      ],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("light");
});

test("top padding ends the walk, so a padded child's background does not reach the status bar", () => {
  const white = el("div", { style: { width: "100%", "background-color": "#ffffff" } });
  const padded = (style: Record<string, string>) =>
    el("div", { style: { "justify-self": "stretch", width: "100%", ...style } }, [white]);
  const black = el("div", {
    style: { "justify-self": "stretch", width: "100%", "background-color": "#000000" },
  });
  const box = (top: WebElement) =>
    el("div", { style: { display: "grid", "grid-template-areas": '"cell"', width: "100%" } }, [
      black,
      top,
    ]);
  expect(appTopColor(box(padded({ "padding-top": "80px" })), "#777777")).toBe("#000000");
  expect(appTopColor(box(padded({ padding: "80px 16px" })), "#777777")).toBe("#000000");
  // Zero top padding still lets the child show.
  expect(appTopColor(box(padded({ padding: "0 16px" })), "#777777")).toBe("#ffffff");
  expect(appTopColor(box(padded({ "padding-top": "0px" })), "#777777")).toBe("#ffffff");
});

test("a padded transparent overlay in a fullscreen box leaves the full-fill colour behind the status bar", () => {
  const still = renderPrototypeStill({
    id: "padded-overlay",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "box",
      style: { width: "fill", height: "fill" },
      children: [
        { type: "column", style: { width: "fill", height: "fill", background: "#000000" } },
        {
          type: "column",
          style: { width: "fill", height: "fill", padding: { top: 80 } },
          children: [{ type: "column", style: { width: "fill", background: "#ffffff" } }],
        },
      ],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("light");
});

test("the walk follows a child only when its container places it at the top", () => {
  const white = (style: Record<string, string> = {}) =>
    el("div", {
      style: { width: "100%", height: "80px", "background-color": "#ffffff", ...style },
    });
  const column = (style: Record<string, string>, children: WebElement[]) =>
    el("div", { style: { display: "flex", "flex-direction": "column", width: "100%", ...style } }, [
      ...children,
    ]);
  expect(appTopColor(column({ "justify-content": "flex-end" }, [white()]), "#000000")).toBe(
    "#000000",
  );
  expect(appTopColor(column({ "justify-content": "center" }, [white()]), "#000000")).toBe(
    "#000000",
  );
  // A growing child fills the column from its top whatever the arrangement.
  expect(
    appTopColor(column({ "justify-content": "flex-end" }, [white({ flex: "1 1 auto" })]), "#000"),
  ).toBe("#ffffff");
  expect(appTopColor(column({}, [white()]), "#000000")).toBe("#ffffff");
  // In a row the vertical axis is align-items, and a full-height child that is narrow does not
  // span the width.
  const row = (style: Record<string, string>, children: WebElement[]) =>
    el("div", { style: { display: "flex", "flex-direction": "row", width: "100%", ...style } }, [
      ...children,
    ]);
  expect(appTopColor(row({ "align-items": "flex-end" }, [white()]), "#000000")).toBe("#000000");
  const rail = el("div", {
    style: { width: "20px", "align-self": "stretch", "background-color": "#ffffff" },
  });
  expect(appTopColor(row({}, [rail]), "#000000")).toBe("#000000");
});

test("a bottom-arranged footer inside a box overlay leaves the full-fill colour behind the status bar", () => {
  const still = renderPrototypeStill({
    id: "nested-footer",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "box",
      style: { width: "fill", height: "fill" },
      children: [
        { type: "column", style: { width: "fill", height: "fill", background: "#000000" } },
        {
          type: "column",
          style: { width: "fill", height: "fill", arrangement: "end" },
          children: [
            { type: "column", style: { width: "fill", height: { dp: 80 }, background: "#ffffff" } },
          ],
        },
      ],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("light");
});

test("a weighted child fills an end-arranged column, so its colour reaches the status bar", () => {
  const still = renderPrototypeStill({
    id: "weighted",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "column",
      style: { width: "fill", height: "fill", background: "#000000", arrangement: "end" },
      children: [{ type: "column", style: { width: "fill", weight: 2, background: "#ffffff" } }],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("dark");
});

test("a full-width child inside a narrow ancestor does not cover the status bar", () => {
  const still = renderPrototypeStill({
    id: "narrow-ancestor",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "box",
      style: { width: "fill", height: "fill" },
      children: [
        { type: "column", style: { width: "fill", height: "fill", background: "#000000" } },
        {
          type: "column",
          style: { width: "fill", height: "fill" },
          children: [
            {
              type: "column",
              style: { width: { dp: 20 }, height: "fill" },
              children: [{ type: "column", style: { width: "fill", background: "#ffffff" } }],
            },
          ],
        },
      ],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("light");
});

test("a sole filling child of a row spans it, and a capped maximum width does not", () => {
  const row = renderPrototypeStill({
    id: "row-fill",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "row",
      style: { width: "fill", height: "fill", background: "#000000" },
      children: [
        { type: "column", style: { width: "fill", height: "fill", background: "#ffffff" } },
      ],
    },
  });
  expect(statusBarOf(row.element)?.attrs["data-status-content"]).toBe("dark");
  const capped = renderPrototypeStill({
    id: "max-width",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "box",
      style: { width: "fill", height: "fill" },
      children: [
        { type: "column", style: { width: "fill", height: "fill", background: "#000000" } },
        {
          type: "column",
          style: { width: "fill", height: "fill", maxWidth: 20, background: "#ffffff" },
        },
      ],
    },
  });
  expect(statusBarOf(capped.element)?.attrs["data-status-content"]).toBe("light");
});

test("a maximum width at least the screen width does not narrow a child", () => {
  const still = renderPrototypeStill({
    id: "wide-cap",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "column",
      style: { width: "fill", height: "fill", background: "#000000" },
      children: [
        {
          type: "column",
          style: { width: "fill", height: "fill", maxWidth: 1000, background: "#ffffff" },
        },
      ],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("dark");
});

test("a growing child held short by a maximum height does not reach the top of an end-arranged column", () => {
  const still = renderPrototypeStill({
    id: "capped-growth",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "box",
      style: { width: "fill", height: "fill" },
      children: [
        { type: "column", style: { width: "fill", height: "fill", background: "#000000" } },
        {
          type: "column",
          style: { width: "fill", height: "fill", arrangement: "end" },
          children: [
            {
              type: "column",
              style: { width: "fill", weight: 1, maxHeight: 80, background: "#ffffff" },
            },
          ],
        },
      ],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("light");
});

test("a row-bound min() maximum width binds only below the screen width", () => {
  const header = (maxWidth: number) =>
    renderPrototypeStill({
      id: "row-bound",
      window: { placement: { type: "fullscreen" } },
      theme: { mode: "light" },
      root: {
        type: "column",
        style: { width: "fill", height: "fill", background: "#000000" },
        children: [
          {
            type: "row",
            style: { width: "fill", height: { dp: 80 }, maxWidth, background: "#ffffff" },
            children: [{ type: "box", style: { aspectRatio: 1, maxWidth } }],
          },
        ],
      },
    });
  expect(statusBarOf(header(1000).element)?.attrs["data-status-content"]).toBe("dark");
  expect(statusBarOf(header(20).element)?.attrs["data-status-content"]).toBe("light");
});

test("a full-width child inside a wrap-sized column does not cover the status bar", () => {
  const still = renderPrototypeStill({
    id: "wrap-ancestor",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "box",
      style: { width: "fill", height: "fill" },
      children: [
        { type: "column", style: { width: "fill", height: "fill", background: "#000000" } },
        {
          type: "column",
          style: { width: "fill", height: "fill" },
          children: [
            {
              type: "column",
              style: { width: "wrap" },
              children: [
                { type: "column", style: { width: "fill", background: "#ffffff" } },
                { type: "text", text: "x", style: { width: { dp: 20 } } },
              ],
            },
          ],
        },
      ],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("light");
});

test("a transparent root does not set the status bar content in a still", () => {
  const still = renderPrototypeStill({
    id: "alpha",
    window: { placement: { type: "fullscreen" } },
    theme: { mode: "light" },
    root: {
      type: "column",
      style: { width: "fill", height: "fill", background: "#000000", alpha: 0 },
      children: [{ type: "text", text: "Hidden" }],
    },
  });
  expect(statusBarOf(still.element)?.attrs["data-status-content"]).toBe("dark");
});

test("a top sheet's content sits behind the status bar; a bottom sheet's does not", () => {
  const sheet = (edge: string) =>
    renderPrototypeStill({
      id: "sheet",
      window: { placement: { type: "sheet", edge, height: 200 } },
      theme: { mode: "light" },
      root: {
        type: "column",
        style: { width: "fill", background: "#1d1b20" },
        children: [{ type: "text", text: "Sheet" }],
      },
    });
  expect(statusBarOf(sheet("top").element)?.attrs["data-status-content"]).toBe("light");
  expect(statusBarOf(sheet("bottom").element)?.attrs["data-status-content"]).toBe("dark");
});
