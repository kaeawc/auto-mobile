import { describe, expect, test } from "bun:test";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { countTappableMatches } from "../../../src/features/utility/tappableMatchCount";
import {
  issue17939Hierarchy,
  issue17939TapLookup,
} from "../../fixtures/ios/issue17939TapMatchCount";

const select = (text: string) =>
  new ResolverElementSelector().selectByText(issue17939Hierarchy(), text, issue17939TapLookup);

describe("tappable match count (#17939)", () => {
  test("a non-tappable context label with the toolbar button's text is not counted", () => {
    const result = select("Add");
    expect(result.totalMatches).toBe(2);
    expect(result.tappableMatches).toBe(1);
    expect(result.indexInMatches).toBe(0);
    expect(result.element?.bounds).toEqual({ left: 338, top: 62, right: 386, bottom: 106 });
  });

  test("a row and its same-label switch count as one match; the row is still tapped", () => {
    const result = select("Dark mode");
    expect(result.totalMatches).toBe(2);
    expect(result.tappableMatches).toBe(1);
    expect(result.indexInMatches).toBe(0);
    expect(result.element?.bounds).toEqual({ left: 16, top: 97, right: 386, bottom: 149 });
  });

  test("a single unambiguous match reports no separate tappable count", () => {
    expect(select("Dogfood").tappableMatches).toBeUndefined();
  });

  const bounds = (left: number, top: number, right: number, bottom: number) => ({
    left,
    top,
    right,
    bottom,
  });

  test("two separate same-label buttons both count", () => {
    expect(
      countTappableMatches([
        { affordances: ["tap"], label: "Delete", bounds: bounds(0, 0, 50, 20) },
        { affordances: ["tap"], label: "Delete", bounds: bounds(0, 40, 50, 60) },
      ]),
    ).toBe(2);
  });

  test("a contained control with a different label counts separately", () => {
    expect(
      countTappableMatches([
        { affordances: ["tap"], label: "Wi-Fi", bounds: bounds(0, 0, 400, 50) },
        { affordances: ["toggle"], label: "Wi-Fi switch", bounds: bounds(300, 10, 380, 40) },
      ]),
    ).toBe(2);
  });

  test("duplicate same-label nodes with identical bounds count once", () => {
    const node = { affordances: ["tap" as const], label: "Add", bounds: bounds(0, 0, 10, 10) };
    expect(countTappableMatches([node, { ...node }])).toBe(1);
  });

  test("unbounded or affordance-less candidates are not counted", () => {
    expect(
      countTappableMatches([
        { affordances: [], label: "Add", bounds: bounds(0, 0, 10, 10) },
        { affordances: ["tap"], label: "Add" },
      ]),
    ).toBe(0);
  });
});
