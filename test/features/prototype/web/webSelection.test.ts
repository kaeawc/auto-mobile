import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WebChild, WebElement } from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";

type Spec = Record<string, unknown>;

const fixture = (name: string): Spec =>
  JSON.parse(
    readFileSync(
      join(import.meta.dir, `../../../fixtures/prototype-spec/valid/${name}.json`),
      "utf8",
    ),
  ) as Spec;

function find(node: WebChild, predicate: (element: WebElement) => boolean): WebElement[] {
  if (typeof node === "string") {
    return [];
  }
  return [
    ...(predicate(node) ? [node] : []),
    ...node.children.flatMap((child) => find(child, predicate)),
  ];
}
const textOf = (node: WebChild): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const byNode = (element: WebElement, type: string) =>
  find(element, (candidate) => candidate.attrs["data-node"] === type);
const byPart = (element: WebElement, part: string) =>
  find(element, (candidate) => candidate.attrs["data-part"] === part);
const byRole = (element: WebElement, role: string) =>
  find(element, (candidate) => candidate.attrs.role === role);

/** Renders one node in a column with the given state and returns that node's element. */
function draw(node: Spec, state: Spec = {}): WebElement {
  const still = renderPrototypeStill({
    id: "s",
    state,
    root: { type: "column", children: [node] },
  });
  expect(still.unsupportedNodes).toEqual([]);
  return byNode(still.element, String(node.type))[0]!;
}

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];
const PRIMARY = "rgba(103,80,164,1)";
const SECONDARY_CONTAINER = "rgba(232,222,248,1)";

describe("web still selection controls (#16537)", () => {
  test("the reference fixtures draw these controls without placeholders", () => {
    for (const name of ["selection-controls", "material-app-bar-dialog-pickers"]) {
      const types = renderPrototypeStill(fixture(name)).unsupportedNodes.map((node) => node.type);
      for (const type of ["radioGroup", "segmentedButton", "timePicker", "datePicker"]) {
        expect(types).not.toContain(type);
      }
    }
  });

  test("a radio group checks the option its state key holds and tags each option", () => {
    const group = draw(
      { type: "radioGroup", stateKey: "k", testTag: "g", options: OPTIONS },
      { k: "b" },
    );
    expect(group.attrs.role).toBe("radiogroup");
    expect(group.style.width).toBeDefined();
    const radios = byRole(group, "radio");
    expect(radios.map((radio) => radio.attrs["aria-checked"])).toEqual(["false", "true", "false"]);
    expect(radios.map((radio) => radio.attrs["data-testid"])).toEqual(["g.a", "g.b", "g.c"]);
    expect(radios.map(textOf)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(byPart(radios[1]!, "radio")[0]!.style.border).toBe(`2px solid ${PRIMARY}`);
    expect(byPart(radios[0]!, "radio")[0]!.children).toEqual([]);
  });

  test("a radio group with a false enabledWhen draws disabled", () => {
    const group = draw(
      {
        type: "radioGroup",
        stateKey: "k",
        options: OPTIONS,
        enabledWhen: { key: "on", equals: true },
      },
      { k: "a", on: false },
    );
    expect(group.attrs["aria-disabled"]).toBe("true");
    expect(group.style.opacity).toBe("0.38");
  });

  test("a select draws its closed field with its label and the chosen option", () => {
    const select = draw(
      { type: "select", stateKey: "k", label: "Size", options: OPTIONS },
      { k: "c" },
    );
    expect(select.attrs["aria-haspopup"]).toBe("listbox");
    expect(textOf(byPart(select, "value")[0]!)).toBe("Gamma");
    expect(textOf(select)).toStartWith("Size");
    expect(find(select, (node) => node.attrs.title === "expand_more")).toHaveLength(1);
  });

  test("a select whose state matches no option shows an empty value", () => {
    const select = draw({ type: "select", stateKey: "k", options: OPTIONS }, { k: "z" });
    expect(textOf(byPart(select, "value")[0]!)).toBe("");
  });

  test("a segmented button fills the selected segment and rounds only its ends", () => {
    const row = draw(
      { type: "segmentedButton", stateKey: "k", testTag: "r", options: OPTIONS },
      { k: "a" },
    );
    const segments = byRole(row, "radio");
    expect(segments.map((segment) => segment.attrs["data-testid"])).toEqual(["r.a", "r.b", "r.c"]);
    expect(segments[0]!.style["background-color"]).toBe(SECONDARY_CONTAINER);
    expect(find(segments[0]!, (node) => node.attrs.title === "check")).toHaveLength(1);
    expect(find(segments[1]!, (node) => node.attrs.title === "check")).toHaveLength(0);
    expect(segments[0]!.style["border-start-start-radius"]).toBe("20px");
    expect(segments[0]!.style["border-start-end-radius"]).toBe("0");
    expect(segments[1]!.style["border-start-start-radius"]).toBe("0");
    expect(segments[2]!.style["border-end-end-radius"]).toBe("20px");
  });

  test("a collapsed search bar shows its placeholder and actions but not its child", () => {
    const bar = draw(
      {
        type: "searchBar",
        stateKey: "q",
        activeKey: "open",
        testTag: "s",
        placeholder: "Search mail",
        leadingIcon: "search",
        trailingActions: [{ icon: "mic", label: "Voice" }],
        child: { type: "text", text: "Results" },
      },
      { q: "", open: false },
    );
    expect(bar.attrs["aria-expanded"]).toBe("false");
    const input = byPart(bar, "input")[0]!;
    expect(input.style["border-radius"]).toBe("28px");
    expect(textOf(input)).toContain("Search mail");
    expect(
      find(bar, (node) => node.attrs["data-testid"] === "s.actions.0")[0]!.attrs["aria-label"],
    ).toBe("Voice");
    expect(textOf(bar)).not.toContain("Results");
  });

  test("an active search bar shows its query and child, and the bar variant fills its height", () => {
    const node = {
      type: "searchBar",
      stateKey: "q",
      activeKey: "open",
      placeholder: "Search",
      child: { type: "text", text: "Results" },
    };
    const bar = draw(node, { q: "cats", open: true });
    expect(bar.attrs["aria-expanded"]).toBe("true");
    expect(textOf(byPart(bar, "input")[0]!)).toBe("cats");
    expect(textOf(bar)).toContain("Results");
    const docked = draw({ ...node, variant: "docked" }, { q: "cats", open: true });
    // In a column, filling the height is growing along it.
    expect(bar.style.flex).toBe("1 1 auto");
    expect(docked.style.flex).toBeUndefined();
  });

  test("an expanded search bar start-aligns its results so a compact button keeps its width", () => {
    const bar = draw(
      {
        type: "searchBar",
        stateKey: "q",
        activeKey: "open",
        placeholder: "Search",
        child: { type: "button", label: "Clear", testTag: "clear" },
      },
      { q: "", open: true },
    );
    expect(bar.style["align-items"]).toBe("flex-start");
    expect(byPart(bar, "input")[0]!.style["align-self"]).toBe("stretch");
    const clear = find(bar, (node) => node.attrs["data-testid"] === "clear")[0]!;
    expect(clear.style.width).toBeUndefined();
    expect(clear.style["align-self"]).toBeUndefined();
  });

  test("a paste button draws as a filled button labelled Paste", () => {
    const paste = draw({ type: "pasteButton", into: "/note", testTag: "p" });
    expect(paste.attrs.role).toBe("button");
    expect(paste.attrs["data-testid"]).toBe("p");
    expect(textOf(paste)).toBe("Paste");
    expect(paste.style["background-color"]).toBe(PRIMARY);
  });
});

describe("web still pickers (#16537)", () => {
  test("a 12-hour time picker shows the hour, minute and PM, with the selector on the hour", () => {
    const picker = draw({ type: "timePicker", hourKey: "h", minuteKey: "m" }, { h: 19, m: 5 });
    const clock = byPart(picker, "clock")[0]!;
    expect(textOf(clock)).toBe("07:05AMPM");
    const period = byPart(picker, "period")[0]!;
    expect(
      period.children.map((half) => (half as WebElement).style["background-color"] !== undefined),
    ).toEqual([false, true]);
    expect(byPart(picker, "hand")[0]!.style.transform).toBe("rotate(210deg)");
    expect(picker.attrs["aria-label"]).toBe("19:05");
  });

  test("a 24-hour time picker has no period selector and puts afternoon hours on the inner ring", () => {
    const picker = draw(
      { type: "timePicker", hourKey: "h", minuteKey: "m", is24Hour: true },
      { h: 19, m: 5 },
    );
    expect(textOf(byPart(picker, "clock")[0]!)).toBe("19:05");
    expect(byPart(picker, "period")).toHaveLength(0);
    expect(textOf(byPart(picker, "dial")[0]!)).toContain("23");
    expect(byPart(picker, "hand")[0]!.style.height).toBe("69px");
  });

  test("a time picker clamps out-of-range state and reads missing keys as zero", () => {
    const picker = draw(
      { type: "timePicker", hourKey: "h", minuteKey: "m", is24Hour: true },
      { h: 40 },
    );
    expect(textOf(byPart(picker, "clock")[0]!)).toBe("23:00");
  });

  test("a date picker shows the bound date's month with that day selected", () => {
    const picker = draw({ type: "datePicker", stateKey: "d" }, { d: "2026-10-08" });
    expect(textOf(byPart(picker, "headline")[0]!)).toBe("Oct 8, 2026");
    expect(textOf(picker)).toContain("October 2026");
    const cells = byRole(picker, "gridcell");
    expect(cells).toHaveLength(31);
    expect(cells.filter((cell) => cell.attrs["aria-selected"] === "true").map(textOf)).toEqual([
      "8",
    ]);
    // October 2026 starts on a Thursday: 7 weekday headers, then 4 blanks, then the 1st.
    const grid = byPart(picker, "month")[0]!;
    expect(grid.children.slice(0, 7).map(textOf)).toEqual(["S", "M", "T", "W", "T", "F", "S"]);
    expect(grid.children.slice(7, 11).map(textOf)).toEqual(["", "", "", ""]);
    expect(textOf(grid.children[11]!)).toBe("1");
  });

  test("a date picker with no valid date shows today's month and the empty headline", () => {
    const still = renderPrototypeStill(
      { id: "s", state: { d: "2026-02-30" }, root: { type: "datePicker", stateKey: "d" } },
      { nowMs: Date.UTC(2024, 1, 10) },
    );
    const picker = byNode(still.element, "datePicker")[0]!;
    expect(textOf(byPart(picker, "headline")[0]!)).toBe("Selected date");
    expect(textOf(picker)).toContain("February 2024");
    expect(byRole(picker, "gridcell")).toHaveLength(29);
    expect(
      byRole(picker, "gridcell").filter((cell) => cell.attrs["aria-selected"] === "true"),
    ).toEqual([]);
  });
});
