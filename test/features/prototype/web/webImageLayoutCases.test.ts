import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  webImageLayoutDifferences,
  webImageLayoutTags,
  type WebImageLayoutBoxes,
} from "./webImageLayoutCases";

const GOLDEN = join(import.meta.dir, "../../../fixtures/prototype-web/image-layout-golden.json");
const box = { x: 0, y: 0, width: 10, height: 10 };
const boxes: WebImageLayoutBoxes = { image: box, parent: box, layer: box };

describe("web image layout cases (#17716)", () => {
  test("the golden has one entry per fixture tag, and the tags are unique", () => {
    const tags = webImageLayoutTags();
    expect(new Set(tags).size).toBe(tags.length);
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, unknown>;
    expect(Object.keys(golden).sort()).toEqual([...tags].sort());
  });

  test("a difference beyond the tolerance, or a missing tag, is reported", () => {
    const moved = { ...boxes, layer: { ...box, width: 10.5 } };
    expect(webImageLayoutDifferences({ a: boxes }, { a: { ...boxes } })).toEqual([]);
    expect(webImageLayoutDifferences({ a: boxes }, { a: moved })).toEqual([
      { tag: "a", expected: boxes, actual: moved },
    ]);
    expect(webImageLayoutDifferences({ a: boxes }, {})).toEqual([
      { tag: "a", expected: boxes, actual: undefined },
    ]);
  });
});
