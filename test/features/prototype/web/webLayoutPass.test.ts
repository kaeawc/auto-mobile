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
    clips: [{ rect: { left: 0, top: 0, width: 20, height: 10 } }],
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

test("fractional grow factors take their share of the initial free space after a cap", () => {
  // CSS: the 0.4 child grows to 160, is capped at 100 and frozen; the 0.6 child then takes 0.6
  // of the initial 400px free space, not of the 300px left after the cap.
  const row = named("row", { display: "flex", "flex-direction": "row" }, [
    named("capped", { flex: "0.4 1 0", "max-width": "100px", height: "10px" }),
    named("rest", { flex: "0.6 1 0", height: "10px" }),
  ]);
  const painted = topEdgePaintOrder(row, SCREEN);
  expect(rectOf(painted, "capped")).toEqual({ left: 0, top: 0, width: 100, height: 10 });
  expect(rectOf(painted, "rest")).toEqual({ left: 100, top: 0, width: 240, height: 10 });
});

test("a line item's ratio-derived main size places the siblings after it", () => {
  const row = named("row", { display: "flex", "flex-direction": "row" }, [
    named("square", { height: "100px", "aspect-ratio": "1" }),
    named("black", { width: "300px", height: "100px" }),
  ]);
  const painted = topEdgePaintOrder(row, SCREEN);
  expect(rectOf(painted, "square")).toEqual({ left: 0, top: 0, width: 100, height: 100 });
  expect(rectOf(painted, "black")).toEqual({ left: 100, top: 0, width: 300, height: 100 });
});

test("a ratio-derived dimension is clamped by its own min and max", () => {
  const root = named("root", {}, [
    named("capped", {
      display: "inline-block",
      height: "400px",
      "aspect-ratio": "1",
      "max-width": "100px",
    }),
  ]);
  expect(rectOf(topEdgePaintOrder(root, SCREEN), "capped")).toEqual({
    left: 0,
    top: 0,
    width: 100,
    height: 400,
  });
});

test("a growing item's minimum is resolved in the freeze rounds, not folded into its basis", () => {
  // CSS: shares of 400 are 133 and 267; the first is frozen at its 180px minimum and the second
  // takes the 220px left.
  const row = named("row", { display: "flex", "flex-direction": "row" }, [
    named("black", { flex: "1 1 0", "min-width": "180px", height: "10px" }),
    named("white", { flex: "2 2 0", height: "10px" }),
  ]);
  const painted = topEdgePaintOrder(row, SCREEN);
  expect(rectOf(painted, "black")).toEqual({ left: 0, top: 0, width: 180, height: 10 });
  expect(rectOf(painted, "white")).toEqual({ left: 180, top: 0, width: 220, height: 10 });
});

test("an auto dimension is derived from the aspect ratio before its minimum applies", () => {
  const grid = named("grid", { display: "grid", width: "400px", height: "400px" }, [
    named("square", {
      width: "100%",
      "min-height": "100px",
      "aspect-ratio": "1",
      "align-self": "center",
    }),
  ]);
  // The root fills the screen, so the 400px-square grid sits inside it.
  const root = named("root", { display: "flex", "flex-direction": "column" }, [grid]);
  expect(rectOf(topEdgePaintOrder(root, SCREEN), "square")).toEqual({
    left: 0,
    top: 0,
    width: 400,
    height: 400,
  });
});

/** A 400px-square row in a screen-filling column, so `height: 100%` resolves to 400. */
const shrinkRow = (black: Record<string, string>) =>
  named("root", { display: "flex", "flex-direction": "column" }, [
    named("row", { display: "flex", "flex-direction": "row", width: "400px", height: "400px" }, [
      named("black", { flex: "1 1 auto", height: "100%", "aspect-ratio": "1", ...black }),
      named("white", { width: "240px", height: "100%", "flex-shrink": "0" }),
    ]),
  ]);

test("negative free space shrinks an item with a zero minimum by its shrink factor", () => {
  // CSS: the 400px square basis and the 240px fixed child overflow 400 by 240; black shrinks.
  const painted = topEdgePaintOrder(shrinkRow({ "min-width": "0" }), SCREEN);
  expect(rectOf(painted, "black")).toEqual({ left: 0, top: 0, width: 160, height: 400 });
  expect(rectOf(painted, "white")).toEqual({ left: 160, top: 0, width: 240, height: 400 });
});

test("an item's automatic minimum keeps its ratio-derived content size when shrinking", () => {
  const painted = topEdgePaintOrder(shrinkRow({}), SCREEN);
  expect(rectOf(painted, "black")).toEqual({ left: 0, top: 0, width: 400, height: 400 });
  expect(rectOf(painted, "white")?.left).toBe(400);
});

test("negative free space is shared by shrink factor times basis, with minimums frozen", () => {
  // 600px of bases in 400px: 200 shrinks 300 by 150 and 100 by 50, unless held at a minimum.
  const row = (minimum: Record<string, string>) =>
    named("row", { display: "flex", "flex-direction": "row" }, [
      named("wide", { width: "300px", height: "10px", ...minimum }),
      named("narrow", { width: "100px", height: "10px" }),
      named("fixed", { flex: "none", width: "200px", height: "10px" }),
    ]);
  const shared = topEdgePaintOrder(row({}), SCREEN);
  expect(rectOf(shared, "wide")?.width).toBe(150);
  expect(rectOf(shared, "narrow")).toEqual({ left: 150, top: 0, width: 50, height: 10 });
  expect(rectOf(shared, "fixed")?.left).toBe(200);
  // Held at 250, wide leaves the narrow item the whole 200px overflow less its 50px share.
  const held = topEdgePaintOrder(row({ "min-width": "250px" }), SCREEN);
  expect(rectOf(held, "wide")?.width).toBe(250);
  expect(rectOf(held, "narrow")).toEqual({ left: 250, top: 0, width: 0, height: 10 });
});

test("a sized item with unmeasured content keeps its size rather than shrinking", () => {
  const row = named("row", { display: "flex", "flex-direction": "row" }, [
    named("card", { width: "300px", height: "10px" }, [named("label", {})]),
    named("rest", { width: "300px", height: "10px", overflow: "hidden" }),
  ]);
  const painted = topEdgePaintOrder(row, SCREEN);
  // The card's content minimum is unknown, so only the clipping item (minimum 0) shrinks.
  expect(rectOf(painted, "card")?.width).toBe(300);
  expect(rectOf(painted, "rest")).toEqual({ left: 300, top: 0, width: 100, height: 10 });
});

test("a shrinking item keeps at least its padding and border", () => {
  // Even with a zero minimum, black's 210px left padding floors its border box at 210.
  const painted = topEdgePaintOrder(
    shrinkRow({ "min-width": "0", "padding-left": "210px" }),
    SCREEN,
  );
  expect(rectOf(painted, "black")?.width).toBe(210);
  expect(rectOf(painted, "white")?.left).toBe(210);
});

test("a rounded box shows at a top-edge point only outside its cut-away corners", () => {
  const circle = named("circle", {
    width: "300px",
    height: "300px",
    "flex-shrink": "0",
    "border-radius": "150px",
  });
  const painted = topEdgePaintOrder(
    named("row", { display: "flex", "flex-direction": "row" }, [circle]),
    SCREEN,
  );
  const box = painted.find((entry) => entry.element === circle)!;
  expect(box.radii?.topLeft).toEqual({ x: 150, y: 150 });
  expect(paintsTopEdgeAt(box, 150)).toBe(true);
  expect(paintsTopEdgeAt(box, 140)).toBe(false);
  expect(paintsTopEdgeAt(box, 160)).toBe(false);
  // Raised so the top edge crosses 100px into the circle: its chord there is wider.
  const raised = { ...box, rect: { ...box.rect, top: -100 } };
  expect(paintsTopEdgeAt(raised, 30)).toBe(true);
  expect(paintsTopEdgeAt(raised, 5)).toBe(false);
});

test("corner radii read logical longhands, scale down when they overlap, and square corners are none", () => {
  const radiiOf = (style: Record<string, string>, width = "100px") =>
    topEdgePaintOrder(
      named("root", {}, [named("box", { width, height: "50px", ...style })]),
      SCREEN,
    )[1]!.radii;
  expect(radiiOf({})).toBeUndefined();
  expect(radiiOf({ "border-radius": "0px" })).toBeUndefined();
  const logical = radiiOf({
    "border-start-start-radius": "10px",
    "border-start-end-radius": "0px",
    "border-end-end-radius": "0px",
    "border-end-start-radius": "0px",
  });
  expect(logical?.topLeft).toEqual({ x: 10, y: 10 });
  expect(logical?.topRight).toEqual({ x: 0, y: 0 });
  // 100px radii sum to 200 on the 50px-tall sides, so every radius scales by a quarter.
  expect(radiiOf({ "border-radius": "100px" })?.topLeft).toEqual({ x: 25, y: 25 });
  expect(radiiOf({ "border-radius": "10px 20px" })?.topRight).toEqual({ x: 20, y: 20 });
  expect(radiiOf({ "border-radius": "50%" })?.topLeft).toEqual({ x: 50, y: 25 });
});

test("a rounded clip hides a top-edge point in its cut-away corner", () => {
  const box: PaintedBox = {
    element: el("div"),
    rect: { left: 0, top: 0, width: 400, height: 100 },
    opacity: 1,
    clips: [
      {
        rect: { left: 0, top: 0, width: 400, height: 100 },
        radii: {
          topLeft: { x: 20, y: 20 },
          topRight: { x: 20, y: 20 },
          bottomRight: { x: 0, y: 0 },
          bottomLeft: { x: 0, y: 0 },
        },
      },
    ],
  };
  expect(paintsTopEdgeAt(box, 10)).toBe(false);
  expect(paintsTopEdgeAt(box, 390)).toBe(false);
  expect(paintsTopEdgeAt(box, 200)).toBe(true);
});
