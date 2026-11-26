import { expect, test } from "bun:test";
import { GRID_AREA } from "../../../../src/features/prototype/web/webCss";
import { withLaterMinStrut } from "../../../../src/features/prototype/web/webLaterMin";
import { el, type WebElement } from "../../../../src/features/prototype/web/webNodes";
import { LATER_SHRINK } from "../../../../src/features/prototype/web/webRowAspect";
import { ROW_MEASURE_KEY } from "../../../../src/features/prototype/web/webStyle";

const context = { mode: "light" as const, palette: new Map(), parentAxis: "row" as const };

test("a strut wrapper keeps the box cell placement so it overlaps its siblings", () => {
  const later = {
    type: "box",
    style: { minWidth: 30, [ROW_MEASURE_KEY]: { shrink: LATER_SHRINK, later: true } },
  };
  const sibling = el("div", { style: { [GRID_AREA]: "cell" } });
  const wrapped = withLaterMinStrut(el("div", { style: { [GRID_AREA]: "cell" } }), later, context);
  expect(wrapped.style[GRID_AREA]).toBe(sibling.style[GRID_AREA]);
  const inner = wrapped.children[0] as WebElement;
  expect(inner.style[GRID_AREA]).toBe("1 / 1");
});
