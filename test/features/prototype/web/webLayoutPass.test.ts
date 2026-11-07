import { expect, test } from "bun:test";
import {
  paintsTopEdgeAt,
  topEdgePaintOrder,
  type PaintedBox,
} from "../../../../src/features/prototype/web/webLayoutPass";
import { el, type WebElement } from "../../../../src/features/prototype/web/webNodes";

const SCREEN = { width: 400, height: 800 };
const named = (name: string, style: Record<string, string>, children: WebElement[] = []) =>
  el("div", { attrs: { "data-name": name }, style }, children);
const rectOf = (painted: PaintedBox[], name: string) =>
  painted.find((box) => box.element.attrs["data-name"] === name)?.rect;

test("a row shares free space by grow factor, holding a capped item at its maximum", () => {
  const row = named("row", { display: "flex", "flex-direction": "row", gap: "10px" }, [
    named("fixed", { width: "90px", height: "10px" }),
    named("capped", { flex: "1 1 0", "max-width": "50px", height: "10px" }),
    named("rest", { flex: "1 1 0", height: "10px" }),
  ]);
  const painted = topEdgePaintOrder(row, SCREEN);
  expect(rectOf(painted, "fixed")).toEqual({ left: 0, top: 0, width: 90, height: 10 });
  expect(rectOf(painted, "capped")).toEqual({ left: 100, top: 0, width: 50, height: 10 });
  // 400 less 90 fixed, 50 capped and two 10px gaps.
  expect(rectOf(painted, "rest")).toEqual({ left: 160, top: 0, width: 240, height: 10 });
});

test("a column's arrangement places its first child from the free space", () => {
  const top = (justify: string) =>
    rectOf(
      topEdgePaintOrder(
        named(
          "column",
          { display: "flex", "flex-direction": "column", "justify-content": justify },
          [named("child", { height: "100px" })],
        ),
        SCREEN,
      ),
      "child",
    )?.top;
  expect(top("flex-start")).toBe(0);
  expect(top("center")).toBe(350);
  expect(top("flex-end")).toBe(700);
  expect(top("space-around")).toBe(350);
  expect(top("space-evenly")).toBe(350);
});

test("an absolute child is placed by its insets against its container", () => {
  const root = named("root", { position: "relative" }, [
    named("overlay", { position: "absolute", inset: "0" }),
    named("badge", {
      position: "absolute",
      right: "10px",
      bottom: "20px",
      width: "30px",
      height: "40px",
    }),
  ]);
  const painted = topEdgePaintOrder(root, SCREEN);
  expect(rectOf(painted, "overlay")).toEqual({ left: 0, top: 0, width: 400, height: 800 });
  // The badge sits at the bottom, so its subtree is not followed, but it is still placed.
  expect(rectOf(painted, "badge")).toEqual({ left: 360, top: 740, width: 30, height: 40 });
});

test("positioned children paint after in-flow ones, ordered by z-index", () => {
  const root = named("root", {}, [
    named("raised", { position: "absolute", inset: "0", "z-index": "2" }),
    named("under", { position: "absolute", inset: "0", "z-index": "-1" }),
    named("flow", {}),
    named("positioned", { position: "absolute", inset: "0" }),
  ]);
  const order = topEdgePaintOrder(root, SCREEN).map((box) => box.element.attrs["data-name"]);
  expect(order).toEqual(["root", "under", "flow", "positioned", "raised"]);
});

test("a clipped subtree below the top edge or one at an unknown place is not descended into", () => {
  const root = named("root", { display: "flex", "flex-direction": "column" }, [
    named("first", { height: "50px" }),
    named("second", { overflow: "hidden" }, [named("inner", {})]),
    named("spun", { position: "absolute", inset: "0", transform: "rotate(10deg)" }, [
      named("hidden", {}),
    ]),
  ]);
  const names = topEdgePaintOrder(root, SCREEN).map((box) => box.element.attrs["data-name"]);
  expect(names).toEqual(["root", "first", "second", "spun"]);
});

test("a box shows at a top-edge point only inside its own rect and every clip", () => {
  const box: PaintedBox = {
    element: el("div"),
    rect: { left: 0, top: 0, width: 400, height: undefined },
    opacity: 1,
    clips: [{ left: 0, top: 0, width: 20, height: 10 }],
  };
  expect(paintsTopEdgeAt(box, 10)).toBe(true);
  expect(paintsTopEdgeAt(box, 30)).toBe(false);
  expect(paintsTopEdgeAt({ ...box, rect: { ...box.rect, top: 1 } }, 10)).toBe(false);
  expect(paintsTopEdgeAt({ ...box, rect: { ...box.rect, width: undefined } }, 10)).toBe(false);
});

test("an unclipped subtree below the top edge is followed, so an overflowing child can reach it", () => {
  // A 100px row 100px down aligns its 250px child to the bottom, so the child starts at y = -50.
  const root = named(
    "root",
    { display: "flex", "flex-direction": "column", "padding-top": "100px" },
    [
      named(
        "row",
        { display: "flex", "flex-direction": "row", height: "100px", "align-items": "flex-end" },
        [named("tall", { width: "400px", height: "250px" })],
      ),
    ],
  );
  expect(rectOf(topEdgePaintOrder(root, SCREEN), "tall")).toEqual({
    left: 0,
    top: -50,
    width: 400,
    height: 250,
  });
});

test("a collection grid places cells row-major in its column tracks", () => {
  const grid = named(
    "grid",
    { display: "grid", "grid-template-columns": "repeat(2, minmax(0, 1fr))", "column-gap": "20px" },
    [
      named("a", { "justify-self": "stretch", "align-self": "start", height: "100px" }),
      named("b", { "justify-self": "stretch", "align-self": "start", height: "100px" }),
      named("c", { "justify-self": "stretch", "align-self": "start", "grid-column": "span 2" }),
    ],
  );
  const painted = topEdgePaintOrder(grid, SCREEN);
  expect(rectOf(painted, "a")).toEqual({ left: 0, top: 0, width: 190, height: 100 });
  expect(rectOf(painted, "b")).toEqual({ left: 210, top: 0, width: 190, height: 100 });
  // The second row starts below the first row's unmeasured height.
  expect(rectOf(painted, "c")?.top).toBeUndefined();
});

test("a ratio-sized line item is aligned with its derived cross size", () => {
  const row = named(
    "row",
    { display: "flex", "flex-direction": "row", height: "400px", "align-items": "center" },
    [named("square", { width: "400px", "aspect-ratio": "1" })],
  );
  // The root fills the screen, so the 400px row sits inside it.
  const root = named("root", { display: "flex", "flex-direction": "column" }, [row]);
  expect(rectOf(topEdgePaintOrder(root, SCREEN), "square")).toEqual({
    left: 0,
    top: 0,
    width: 400,
    height: 400,
  });
});

test("a growing item's minimum wins over a smaller maximum", () => {
  const row = named("row", { display: "flex", "flex-direction": "row" }, [
    named("item", { flex: "1 1 0", "min-width": "300px", "max-width": "100px", height: "10px" }),
  ]);
  expect(rectOf(topEdgePaintOrder(row, SCREEN), "item")).toEqual({
    left: 0,
    top: 0,
    width: 300,
    height: 10,
  });
});

test("an absolute child derives its unknown dimension from its aspect ratio before placing", () => {
  const root = named("root", { position: "relative" }, [
    named("square", { position: "absolute", top: "0", height: "400px", "aspect-ratio": "1" }),
    named("end", {
      position: "absolute",
      top: "0",
      right: "0",
      height: "100px",
      "aspect-ratio": "2 / 1",
    }),
  ]);
  const painted = topEdgePaintOrder(root, SCREEN);
  expect(rectOf(painted, "square")).toEqual({ left: 0, top: 0, width: 400, height: 400 });
  expect(rectOf(painted, "end")).toEqual({ left: 200, top: 0, width: 200, height: 100 });
});

test("a content-sized wrapper takes its measurable children's size before it is aligned", () => {
  // The still's floating window: a centred grid cell holding an unsized translate wrapper.
  const window = named(
    "window",
    { display: "grid", "align-items": "center", "justify-items": "center" },
    [
      named("wrapper", { transform: "translate(0px, 0px)", padding: "5px" }, [
        named("panel", { width: "390px", height: "890px" }),
      ]),
    ],
  );
  const painted = topEdgePaintOrder(window, SCREEN);
  expect(rectOf(painted, "wrapper")).toEqual({ left: 0, top: -50, width: 400, height: 900 });
  expect(rectOf(painted, "panel")).toEqual({ left: 5, top: -45, width: 390, height: 890 });
});

test("a wrapper with text or an unsized child stays unmeasured", () => {
  const centred = (children: (WebElement | string)[]) =>
    rectOf(
      topEdgePaintOrder(
        named("box", { display: "grid", "align-items": "center" }, [
          el("div", { attrs: { "data-name": "wrapper" }, style: {} }, children),
        ]),
        SCREEN,
      ),
      "wrapper",
    )?.top;
  expect(centred([named("sized", { height: "100px" })])).toBe(350);
  expect(centred([named("sized", { height: "100px" }), "label"])).toBeUndefined();
  expect(centred([named("sized", { height: "100px" }), named("unsized", {})])).toBeUndefined();
});
