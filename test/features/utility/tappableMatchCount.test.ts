import { describe, expect, test } from "bun:test";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { countTappableMatches } from "../../../src/features/utility/tappableMatchCount";
import demosTab from "../../fixtures/ios/tab-bar-tap-match/ios26_5-demos-tab.viewHierarchy.json";
import filesTab from "../../fixtures/ios/tab-bar-tap-match/ios26_5-files-tab.viewHierarchy.json";
import { viewHierarchyFromFixture } from "../../helpers/observeFixture";
import {
  issue17939Hierarchy,
  issue17939TapLookup,
} from "../../fixtures/ios/issue17939TapMatchCount";

const select = (text: string) =>
  new ResolverElementSelector().selectByText(issue17939Hierarchy(), text, issue17939TapLookup);

describe("tab bar tappable match count (#18088)", () => {
  test.each([
    { text: "Demos", capture: demosTab, total: 3, left: 110, right: 205 },
    { text: "Files", capture: filesTab, total: 2, left: 196, right: 291 },
  ])("$text counts the tab button once despite its announcing tab bar", (screen) => {
    const result = new ResolverElementSelector().selectByText(
      viewHierarchyFromFixture(screen.capture),
      screen.text,
      issue17939TapLookup,
    );
    expect(result.totalMatches).toBe(screen.total);
    expect(result.tappableMatches).toBe(1);
    expect(result.indexInMatches).toBe(0);
    expect(result.element?.bounds).toEqual({
      left: screen.left,
      top: 795,
      right: screen.right,
      bottom: 849,
    });
  });
});

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

  test("a container whose sublabel does not announce the inner label counts separately", () => {
    expect(
      countTappableMatches([
        {
          affordances: ["tap"],
          label: "Wi-Fi",
          sublabel: "Network settings",
          bounds: bounds(0, 0, 400, 50),
        },
        { affordances: ["toggle"], label: "Wi-Fi switch", bounds: bounds(300, 10, 380, 40) },
      ]),
    ).toBe(2);
  });

  test("a container announces a contained button case-insensitively in either candidate order", () => {
    const container = {
      affordances: ["tap" as const],
      label: "Tab Bar",
      sublabel: "Home, FILES, Settings",
      bounds: bounds(0, 0, 400, 50),
    };
    const button = {
      affordances: ["tap" as const],
      label: "Files",
      bounds: bounds(100, 10, 200, 40),
    };
    expect(countTappableMatches([container, button])).toBe(1);
    expect(countTappableMatches([button, container])).toBe(1);
    expect(countTappableMatches([{ ...container, sublabel: undefined }, button])).toBe(2);
  });

  test("mutually announcing targets with identical bounds keep one match", () => {
    const container = {
      affordances: ["tap" as const],
      label: "Tab Bar",
      sublabel: "Files",
      bounds: bounds(0, 0, 100, 50),
    };
    const button = { ...container, label: "Files", sublabel: "Tab Bar" };
    expect(countTappableMatches([container, button])).toBe(1);
    expect(countTappableMatches([button, container])).toBe(1);
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

  test("a sublabel naming the label only inside a longer word does not fold (#18098)", () => {
    const container = {
      affordances: ["tap" as const],
      label: "Tab Bar",
      sublabel: "Home, Profiles",
      bounds: bounds(0, 0, 400, 50),
    };
    const button = {
      affordances: ["tap" as const],
      label: "Files",
      bounds: bounds(100, 10, 200, 40),
    };
    expect(countTappableMatches([container, button])).toBe(2);
    expect(
      countTappableMatches([{ ...container, sublabel: "Home, Files+, Profiles" }, button]),
    ).toBe(1);
    expect(
      countTappableMatches([
        { ...container, sublabel: "C++ (beta)" },
        { ...button, label: "C++ (beta)" },
      ]),
    ).toBe(1);
  });

  test("a three-target fold cycle keeps one match (#18098)", () => {
    // A folds into B (A's sublabel names B), B into C (B's sublabel names C), C into A (same label).
    const a = {
      affordances: ["tap" as const],
      label: "Files",
      sublabel: "Tab Bar",
      bounds: bounds(0, 0, 400, 100),
    };
    const b = {
      affordances: ["tap" as const],
      label: "Tab Bar",
      sublabel: "Files",
      bounds: bounds(10, 10, 390, 90),
    };
    const c = { affordances: ["tap" as const], label: "Files", bounds: bounds(20, 20, 380, 80) };
    expect(countTappableMatches([a, b, c])).toBe(1);
    expect(countTappableMatches([c, b, a])).toBe(1);
    expect(countTappableMatches([b, c, a])).toBe(1);
  });

  test("a fold cycle inside a separate container's target counts with that target", () => {
    const box = bounds(0, 0, 100, 50);
    const a = { affordances: ["tap" as const], label: "Files", sublabel: "Tab Bar", bounds: box };
    const b = { affordances: ["tap" as const], label: "Tab Bar", sublabel: "Files", bounds: box };
    const elsewhere = {
      affordances: ["tap" as const],
      label: "Files",
      bounds: bounds(0, 60, 100, 90),
    };
    expect(countTappableMatches([a, b, elsewhere])).toBe(2);
  });
});
