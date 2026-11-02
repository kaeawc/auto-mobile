import { expect, test } from "bun:test";
import { prototypeRolePalette } from "../../../../src/features/prototype/prototypeContrast";
import {
  boxLayoutCss,
  lineCss,
  nodeCss,
  textCss,
} from "../../../../src/features/prototype/web/webStyle";

const context = { mode: "light" as const, palette: prototypeRolePalette({}, "light") };

test("fill takes the remaining main axis and stretches the cross axis", () => {
  expect(nodeCss({ height: "fill" }, { ...context, parentAxis: "column" })).toMatchObject({
    flex: "1 1 auto",
  });
  expect(nodeCss({ width: "fill" }, { ...context, parentAxis: "column" })).toMatchObject({
    "align-self": "stretch",
    width: "100%",
  });
});

test("a dp size is fixed and does not shrink", () => {
  expect(nodeCss({ width: { dp: 40 } }, context)).toMatchObject({
    width: "40px",
    "flex-shrink": "0",
  });
});

test("weight shares the parent's main axis", () => {
  expect(nodeCss({ weight: 2 }, { ...context, parentAxis: "row" })).toMatchObject({
    flex: "2 2 0",
    "min-width": "0",
  });
});

test("corner radius accepts numbers, shape tokens and per-corner objects", () => {
  expect(nodeCss({ cornerRadius: "medium" }, context)["border-radius"]).toBe("12px");
  expect(nodeCss({ cornerRadius: 6 }, context)["border-radius"]).toBe("6px");
  // Per-corner radii are logical, so an RTL window mirrors them.
  expect(nodeCss({ cornerRadius: { topStart: 8 } }, context)).toMatchObject({
    "border-start-start-radius": "8px",
    "border-start-end-radius": "0px",
    "border-end-end-radius": "0px",
    "border-end-start-radius": "0px",
  });
  expect(nodeCss({ cornerRadius: { topStart: 8 } }, context)).not.toHaveProperty("border-radius");
});

test("padding uses logical start and end", () => {
  expect(nodeCss({ padding: { start: 4, end: 8 } }, context)).toMatchObject({
    "padding-inline-start": "4px",
    "padding-inline-end": "8px",
  });
});

test("a light/dark colour pair resolves per mode", () => {
  const pair = { light: "#FF0000", dark: "#00FF00" };
  expect(nodeCss({ background: pair }, context)["background-color"]).toBe("rgba(255,0,0,1)");
  expect(
    nodeCss({ background: pair }, { mode: "dark", palette: prototypeRolePalette({}, "dark") })[
      "background-color"
    ],
  ).toBe("rgba(0,255,0,1)");
});

test("rows arrange and align along their axes", () => {
  expect(
    lineCss("row", { arrangement: "spaceBetween", alignment: "bottomStart", spacing: 8 }),
  ).toEqual({
    display: "flex",
    "flex-direction": "row",
    "justify-content": "space-between",
    gap: "8px",
    "align-items": "flex-end",
  });
});

test("a line start-aligns its children on the cross axis by default, as on devices", () => {
  expect(lineCss("column", {})["align-items"]).toBe("flex-start");
  expect(lineCss("row", undefined)["align-items"]).toBe("flex-start");
});

test("a box aligns its children on one grid cell", () => {
  expect(boxLayoutCss({ alignment: "bottomEnd" })).toMatchObject({
    "align-items": "end",
    "justify-items": "end",
  });
  expect(boxLayoutCss(undefined)).toMatchObject({
    "align-items": "start",
    "justify-items": "start",
  });
});

test("maps every text decoration to CSS", () => {
  const decoration = (textDecoration: string) =>
    textCss({ textDecoration }, context)["text-decoration"];
  expect(decoration("lineThrough")).toBe("line-through");
  expect(decoration("underline")).toBe("underline");
  expect(decoration("underlineLineThrough")).toBe("underline line-through");
  expect(decoration("none")).toBe("none");
});

test("inside a box grid, a width-only fill stretches horizontally only", () => {
  const css = nodeCss({ width: "fill", height: "wrap" }, context);
  expect(css).toMatchObject({ "justify-self": "stretch", width: "100%" });
  expect(css).not.toHaveProperty("align-self");
  expect(nodeCss({ height: "fill" }, context)).toMatchObject({ "align-self": "stretch" });
});

test("maps built-in font families to CSS", () => {
  expect(textCss({ fontFamily: "serif" }, context)["font-family"]).toBe("serif");
  expect(textCss({ fontFamily: "monospace" }, context)["font-family"]).toBe("monospace");
  expect(textCss({ fontFamily: "sansSerif" }, context)["font-family"]).toBe("sans-serif");
  expect(textCss({ fontFamily: "default" }, context)).not.toHaveProperty("font-family");
});

test("an explicit normal font style is emitted so it overrides an italic parent", () => {
  expect(textCss({ fontStyle: "normal" }, context)["font-style"]).toBe("normal");
  expect(textCss({ fontStyle: "italic" }, context)["font-style"]).toBe("italic");
});
