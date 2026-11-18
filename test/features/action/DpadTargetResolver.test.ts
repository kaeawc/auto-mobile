import { describe, expect, test } from "bun:test";
import {
  type DpadSelector,
  focusOwnerBounds,
  pinnedFocusOptions,
  SelectorDpadTargetResolver,
} from "../../../src/features/action/DpadTargetResolver";
import type { ElementResolution } from "../../../src/features/utility/ElementResolver";
import type { FocusScreen } from "../../../src/features/action/FocusNavigate";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type {
  ElementBounds,
  ElementSelectionResult,
  ViewHierarchyResult,
} from "../../../src/models";
import type { ElementQuery } from "../../../src/models/ElementQuery";
import type { ElementSelectionOptions } from "../../../src/utils/interfaces/ElementSelector";
import { createFlatNodeForTest, type FlatHierarchyNode } from "../observe/flatHierarchyBuilders";

const FIELD_BOUNDS = { left: 0, top: 0, right: 100, bottom: 50 };

// Hand-built, not a device capture: an empty search field labelled only by its hint.
const searchField: ViewHierarchyResult = {
  hierarchy: {
    node: createFlatNodeForTest({
      bounds: FIELD_BOUNDS,
      class: "android.widget.EditText",
      "resource-id": "app:id/search",
      "hint-text": "Search",
      clickable: true,
      focusable: true,
    }),
  },
};

const screen = (hierarchy?: ViewHierarchyResult): FocusScreen => ({
  focused: null,
  elements: [],
  ...(hierarchy ? { hierarchy } : {}),
});

const emptyResolution: ElementResolution = {
  chosen: null,
  candidates: [],
  matches: [],
  matchMode: "exact",
};

class FakeSelector implements DpadSelector {
  readonly calls: Array<{ query: ElementQuery; options?: ElementSelectionOptions }> = [];
  constructor(private readonly result: ElementSelectionResult) {}
  selectWithResolution(
    _capture: ViewHierarchyResult,
    query: ElementQuery,
    options?: ElementSelectionOptions,
  ) {
    this.calls.push({ query, ...(options ? { options } : {}) });
    return { selection: this.result, resolution: emptyResolution };
  }
}

type TestNode = FlatHierarchyNode & { bounds: ElementBounds };

/** A flat node whose bounds stay typed, so assertions can read them back. */
const node = (attributes: TestNode): TestNode => createFlatNodeForTest(attributes) as TestNode;

const root = (children: FlatHierarchyNode[]): FlatHierarchyNode =>
  createFlatNodeForTest({ bounds: { left: 0, top: 0, right: 1080, bottom: 2400 }, node: children });

const capture = (...children: FlatHierarchyNode[]): ViewHierarchyResult => ({
  hierarchy: { node: root(children) },
});

/** Two windows: `lower` under `upper`, the overlay that ranks first. */
const windowed = (lower: FlatHierarchyNode[], upper: FlatHierarchyNode[]): ViewHierarchyResult => ({
  hierarchy: {},
  windows: [
    { windowLayer: 1, hierarchy: { node: [root(lower)] } },
    { windowLayer: 5, hierarchy: { node: [root(upper)] } },
  ],
});

const miss: ElementSelectionResult = {
  element: null,
  totalMatches: 0,
  indexInMatches: -1,
  strategy: "first",
};

describe("SelectorDpadTargetResolver", () => {
  test("leaves a read without a hierarchy to the focus loop's own matching", () => {
    const selector = new FakeSelector(miss);
    expect(new SelectorDpadTargetResolver(selector).resolve(screen(), { label: "Play" })).toBe(
      undefined,
    );
    expect(selector.calls).toEqual([]);
  });

  test("resolves text with the touch tap's options, including hint fallback", () => {
    const selector = new FakeSelector(miss);
    const resolved = new SelectorDpadTargetResolver(selector).resolve(screen(searchField), {
      label: "Play",
    });
    expect(resolved).toBeNull();
    expect(selector.calls).toEqual([
      {
        query: { text: "Play" },
        options: {
          partialMatch: true,
          caseSensitive: false,
          strategy: "first",
          intentAction: "inspect",
          allowHintFallback: true,
          selectionIntent: "tap",
        },
      },
    ]);
  });

  const real = () => new SelectorDpadTargetResolver(new ResolverElementSelector());

  test("keeps a neighbour label pin when only a non-focusable node matches", () => {
    const neighbour = node({ bounds: FIELD_BOUNDS, text: "Neighbour", focusable: "false" });
    expect(real().resolve(screen(capture(neighbour)), { label: "Neighbour" })).toEqual(
      FIELD_BOUNDS,
    );
  });

  test("keeps a focusable tap selection even when another label match is larger", () => {
    const chosen = node({ bounds: FIELD_BOUNDS, text: "Play", focusable: "true" });
    const larger = node({ ...chosen, bounds: { left: 0, top: 100, right: 500, bottom: 400 } });
    expect(real().resolve(screen(capture(larger, chosen)), { label: "Play" })).toEqual(
      chosen.bounds,
    );
  });

  // A focused row owns the exact "Movies" label; the separate "Movies Plus" control only
  // contains it, so the row keeps the pin even though the other control is focusable.
  const moviesLabel = node({
    bounds: { left: 10, top: 10, right: 200, bottom: 90 },
    text: "Movies",
  });
  const moviesRow = node({
    bounds: { left: 0, top: 0, right: 500, bottom: 100 },
    focusable: "true",
    focused: "true",
    node: [moviesLabel],
  });
  const moviesPlus = node({
    bounds: { left: 600, top: 0, right: 700, bottom: 50 },
    text: "Movies Plus",
    focusable: "true",
  });

  test("an exact label in a focused row pins the row, not a focusable contains match", () => {
    const read = screen(capture(moviesRow, moviesPlus));
    expect(real().resolve(read, { label: "Movies" })).toEqual(moviesRow.bounds);
    expect(real().resolve(read, { label: "Movies Plus" })).toEqual(moviesPlus.bounds);
  });

  test("prefers the label's focusable ancestor over another focusable label match", () => {
    const title = node({ bounds: { left: 10, top: 10, right: 200, bottom: 40 }, text: "Volume" });
    const row = node({
      bounds: { left: 0, top: 0, right: 1000, bottom: 100 },
      focusable: "true",
      node: [title],
    });
    const knob = node({
      bounds: { left: 0, top: 300, right: 300, bottom: 400 },
      "content-desc": "Volume",
      focusable: "true",
    });
    expect(real().resolve(screen(capture(row, knob)), { label: "Volume" })).toEqual(row.bounds);
  });

  test("a clickable, non-focusable button keeps its bounds inside a focused row", () => {
    // The row takes focus but the button is its own control: focus on the row is not the button.
    const remove = node({
      bounds: { left: 800, top: 20, right: 980, bottom: 80 },
      text: "Delete",
      clickable: "true",
      focusable: "false",
    });
    const row = node({
      bounds: { left: 0, top: 0, right: 1000, bottom: 100 },
      focusable: "true",
      focused: "true",
      node: [remove],
    });
    const other = node({
      bounds: { left: 0, top: 300, right: 300, bottom: 400 },
      "content-desc": "Delete",
      focusable: "true",
    });
    expect(real().resolve(screen(capture(row, other)), { label: "Delete" })).toEqual(remove.bounds);
  });

  test("a label under a clickable intermediate is not promoted past it to a focused row", () => {
    const title = node({ bounds: { left: 810, top: 30, right: 970, bottom: 70 }, text: "Remove" });
    const button = node({
      bounds: { left: 800, top: 20, right: 980, bottom: 80 },
      clickable: "true",
      focusable: "false",
      node: [title],
    });
    const row = node({
      bounds: { left: 0, top: 0, right: 1000, bottom: 100 },
      focusable: "true",
      focused: "true",
      node: [button],
    });
    const resolved = real().resolve(screen(capture(row)), { label: "Remove" });
    expect(resolved).toEqual(button.bounds);
  });

  test("a focused row in the upper window beats a focusable control in a lower window", () => {
    const lower = node({
      bounds: { left: 0, top: 500, right: 100, bottom: 550 },
      text: "Movies",
      focusable: "true",
    });
    const read = screen(windowed([lower], [moviesRow]));
    expect(real().resolve(read, { label: "Movies" })).toEqual(moviesRow.bounds);
  });

  test("the fallback stays in the selected label's window", () => {
    const label = node({ bounds: FIELD_BOUNDS, text: "Movies" });
    const lower = node({
      bounds: { left: 0, top: 500, right: 100, bottom: 550 },
      text: "Movies",
      focusable: "true",
    });
    const read = screen(windowed([lower], [label]));
    expect(real().resolve(read, { label: "Movies" })).toEqual(FIELD_BOUNDS);
  });

  test("falls back to the smallest focusable match, exact before contains", () => {
    const title = node({ bounds: FIELD_BOUNDS, text: "Play" });
    const play = node({
      bounds: { left: 0, top: 100, right: 300, bottom: 200 },
      "content-desc": "Play",
      focusable: "true",
    });
    const smallerPlay = node({ ...play, bounds: { left: 0, top: 300, right: 200, bottom: 350 } });
    const playAll = node({
      bounds: { left: 0, top: 60, right: 20, bottom: 70 },
      text: "Play all",
      focusable: "true",
    });
    const read = screen(capture(title, playAll, play, smallerPlay));
    expect(real().resolve(read, { label: "play" })).toEqual(smallerPlay.bounds);
  });

  test("does not reintroduce a parked off-screen focusable duplicate", () => {
    const title = node({ bounds: FIELD_BOUNDS, text: "Ring volume" });
    const parked = node({
      bounds: { left: 2000, top: 3000, right: 2100, bottom: 3050 },
      "content-desc": "Ring volume",
      focusable: "true",
    });
    const panel = node({ bounds: { left: 0, top: 0, right: 1080, bottom: 1000 }, node: [title] });
    const parkedHost = node({
      bounds: { left: 0, top: 1000, right: 1080, bottom: 1200 },
      node: [parked],
    });
    expect(real().resolve(screen(capture(panel, parkedHost)), { label: "Ring volume" })).toEqual(
      FIELD_BOUNDS,
    );
  });

  test("resolves elementId exactly", () => {
    const selector = new FakeSelector(miss);
    new SelectorDpadTargetResolver(selector).resolve(screen(searchField), { elementId: "s2-1" });
    expect(selector.calls[0]).toMatchObject({
      query: { elementId: "s2-1" },
      options: { partialMatch: false, strategy: "first" },
    });
  });

  test("the real selector finds an empty field by its placeholder", () => {
    const resolver = new SelectorDpadTargetResolver(new ResolverElementSelector());
    expect(resolver.resolve(screen(searchField), { label: "Search" })).toEqual(
      expect.objectContaining(FIELD_BOUNDS),
    );
    expect(resolver.resolve(screen(searchField), { label: "Settings" })).toBeNull();
  });
});

describe("focusOwnerBounds", () => {
  const remove = (parent: TestNode): ResolvedSnapshot => {
    const { resolution } = new ResolverElementSelector().selectWithResolution(
      capture(parent),
      { text: "Remove" },
      { partialMatch: true, strategy: "first", intentAction: "inspect" },
    );
    const nodes = resolution.snapshotNodes ?? [];
    const label = nodes.find((entry) => entry.element?.text === "Remove");
    if (!label) {
      throw new Error("label not in snapshot");
    }
    return { chosen: label, candidates: [label], snapshotNodes: nodes };
  };
  type ResolvedSnapshot = Pick<ElementResolution, "chosen" | "candidates" | "snapshotNodes">;
  const title = node({ bounds: { left: 810, top: 30, right: 970, bottom: 70 }, text: "Remove" });
  const rowBounds = { left: 0, top: 0, right: 1000, bottom: 100 };

  test("stops the ancestor walk at a clickable intermediate, keeping the label's bounds", () => {
    const button = node({
      bounds: { left: 800, top: 20, right: 980, bottom: 80 },
      clickable: "true",
      focusable: "false",
      node: [title],
    });
    const row = node({ bounds: rowBounds, focusable: "true", focused: "true", node: [button] });
    expect(focusOwnerBounds(remove(row), "Remove")).toEqual(title.bounds);
  });

  test("promotes a pure label to its nearest focusable ancestor", () => {
    const row = node({ bounds: rowBounds, focusable: "true", focused: "true", node: [title] });
    expect(focusOwnerBounds(remove(row), "Remove")).toEqual(rowBounds);
  });
});

describe("pinnedFocusOptions", () => {
  const pinned = { left: 0, top: 50, right: 100, bottom: 100 };
  const resolver = {
    calls: [] as unknown[],
    resolve(s: FocusScreen, t: unknown) {
      this.calls.push([s, t]);
      return pinned;
    },
  };

  test("pins a label or elementId target to the element the resolver picks", () => {
    for (const until of [{ label: "Play" }, { elementId: "app:id/play" }]) {
      const options = pinnedFocusOptions(until, resolver);
      expect(options.firstMatch).toBe(true);
      const read = screen(searchField);
      expect(options.pinTarget?.(read)).toEqual(pinned);
      expect(resolver.calls.at(-1)).toEqual([read, until]);
    }
  });

  test("leaves focusNavigate's own matching for other targets", () => {
    expect(pinnedFocusOptions({ resourceId: "app:id/play" }, resolver)).toEqual({});
    expect(pinnedFocusOptions({ text: "Play" }, resolver)).toEqual({});
  });

  test("does not pin a target that combines its label or elementId with other fields", () => {
    // The resolver reads one field; pinning would drop the rest of the conjunction.
    expect(pinnedFocusOptions({ label: "More", resourceId: "app:id/right" }, resolver)).toEqual({});
    expect(pinnedFocusOptions({ elementId: "app:id/more", text: "More" }, resolver)).toEqual({});
    expect(pinnedFocusOptions({ label: "More", labelExact: true }, resolver)).toEqual({});
  });
});
