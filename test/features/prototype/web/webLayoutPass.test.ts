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

test("a subtree below the top edge or at an unknown place is not descended into", () => {
  const root = named("root", { display: "flex", "flex-direction": "column" }, [
    named("first", { height: "50px" }),
    named("second", {}, [named("inner", {})]),
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
