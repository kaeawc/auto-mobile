import { describe, expect, test } from "bun:test";
import contract from "../../../../schemas/prototype-spec-contract.json";
import { prototypeRolePalette } from "../../../../src/features/prototype/prototypeContrast";
import { toHtml, type WebChild } from "../../../../src/features/prototype/web/webNodes";
import { children, type WebRenderScope } from "../../../../src/features/prototype/web/webRender";
import {
  MAX_WEB_REPEAT_ITEMS,
  webRepeatLimit,
} from "../../../../src/features/prototype/web/webRepeat";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";

const LIST_LIMIT = contract.limits.MAX_PROTOTYPE_LIST_ITEMS;

const rowsOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `r${index}`, title: `Row ${index}` }));

const scopeFor = (data: unknown): WebRenderScope => ({
  style: { mode: "light", palette: prototypeRolePalette({}, "light"), parentAxis: "column" },
  condition: { state: {}, platform: "android" },
  data,
  spec: { data },
  format: { locale: "en-US", timeZone: "UTC", nowMs: 0 },
  instances: [],
  inBox: false,
  unsupported: [],
  screenWidth: 412,
  screenHeight: 915,
  layers: [],
});

const listOf = (extra: Record<string, unknown> = {}) => ({
  type: "list",
  repeat: { items: { path: "/rows" }, key: "id" },
  children: [{ type: "text", text: "{item.title}" }],
  ...extra,
});

const textOf = (node: WebChild): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

describe("web repeat limit per container (#16607)", () => {
  test("a list draws a 201-row repeat in full", () => {
    const data = { rows: rowsOf(201) };
    const drawn = children(listOf(), scopeFor(data), "root");
    expect(drawn).toHaveLength(201);
    expect(textOf(drawn[200]!)).toBe("Row 200");
  });

  test("a list's maxItems caps its rows below the list contract limit", () => {
    const data = { rows: rowsOf(201) };
    expect(children(listOf({ maxItems: 5 }), scopeFor(data), "root")).toHaveLength(5);
    expect(webRepeatLimit(listOf({ maxItems: 300 }))).toBe(300);
  });

  test("a list never draws past the list contract limit", () => {
    expect(webRepeatLimit(listOf())).toBe(LIST_LIMIT);
    expect(webRepeatLimit(listOf({ maxItems: LIST_LIMIT + 1 }))).toBe(LIST_LIMIT);
    expect(webRepeatLimit(listOf({ maxItems: "lots" }))).toBe(LIST_LIMIT);
  });

  test("an ordinary repeat stays capped at 200", () => {
    const data = { rows: rowsOf(201) };
    const column = { ...listOf(), type: "column" };
    expect(webRepeatLimit(column)).toBe(MAX_WEB_REPEAT_ITEMS);
    expect(children(column, scopeFor(data), "root")).toHaveLength(MAX_WEB_REPEAT_ITEMS);
    const still = renderPrototypeStill({
      id: "s",
      data,
      root: { ...column, testTag: "rows" },
    });
    expect(toHtml(still.element)).toContain("Row 199");
    expect(toHtml(still.element)).not.toContain("Row 200");
  });
});
