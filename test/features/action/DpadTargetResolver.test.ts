import { describe, expect, test } from "bun:test";
import {
  pinnedFocusOptions,
  SelectorDpadTargetResolver,
} from "../../../src/features/action/DpadTargetResolver";
import type { FocusScreen } from "../../../src/features/action/FocusNavigate";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type {
  Element,
  ElementBounds,
  ElementSelectionResult,
  ViewHierarchyResult,
} from "../../../src/models";
import type { ElementQuery } from "../../../src/models/ElementQuery";
import type {
  ElementSelectionOptions,
  ElementSelector,
} from "../../../src/utils/interfaces/ElementSelector";
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

class FakeSelector implements Pick<ElementSelector, "select"> {
  readonly calls: Array<{ query: ElementQuery; options?: ElementSelectionOptions }> = [];
  constructor(private readonly result: ElementSelectionResult) {}
  select(_capture: ViewHierarchyResult, query: ElementQuery, options?: ElementSelectionOptions) {
    this.calls.push({ query, ...(options ? { options } : {}) });
    return this.result;
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
    { windowLayer: 1, hierarchy: { node: root(lower) } },
    { windowLayer: 5, hierarchy: { node: root(upper) } },
  ],
});

const selected = (element: TestNode): ElementSelectionResult => ({
  element: element as Element,
  totalMatches: 1,
  indexInMatches: 0,
  strategy: "first",
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

  test("keeps a neighbour label pin when only a non-focusable node matches", () => {
    const neighbour = node({ bounds: FIELD_BOUNDS, text: "Neighbour", focusable: "false" });
    const selector = new FakeSelector(selected(neighbour));
    expect(
      new SelectorDpadTargetResolver(selector).resolve(screen(capture(neighbour)), {
        label: "Neighbour",
      }),
    ).toEqual(FIELD_BOUNDS);
  });

  test.each([false, "false", undefined])(
    "prefers focusable label matches by area then hierarchy order (selected focusable: %s)",
    (focusable) => {
      const title = node({ bounds: FIELD_BOUNDS, text: "Ring volume", focusable });
      const large = node({
        bounds: { left: 0, top: 100, right: 200, bottom: 200 },
        "content-desc": "RING VOLUME",
        focusable: true,
      });
      const small = node({
        bounds: { left: 0, top: 200, right: 100, bottom: 250 },
        "content-desc": "Ring volume",
        focusable: "true",
      });
      const tied = node({ ...small, bounds: { left: 0, top: 250, right: 100, bottom: 300 } });
      const unrelated = node({ ...small, bounds: FIELD_BOUNDS, "content-desc": "Media volume" });
      const selector = new FakeSelector(selected(title));
      const read = screen(capture(title, unrelated, large, small, tied));
      expect(
        new SelectorDpadTargetResolver(selector).resolve(read, { label: "ring volume" }),
      ).toEqual(small.bounds);
    },
  );

  test("keeps a focusable tap selection even when another label match is smaller", () => {
    const chosen = node({ bounds: FIELD_BOUNDS, text: "Play", focusable: "true" });
    const smaller = node({ ...chosen, bounds: { left: 0, top: 0, right: 10, bottom: 10 } });
    const selector = new FakeSelector(selected(chosen));
    expect(
      new SelectorDpadTargetResolver(selector).resolve(screen(capture(smaller, chosen)), {
        label: "Play",
      }),
    ).toEqual(chosen.bounds);
  });

  // A focused row owns the exact "Movies" label; the separate "Movies Plus" control only
  // contains it, so the row's exact label keeps the pin even though the other is focusable.
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

  test("pins an exact non-focusable label to its focusable row, not a contains match", () => {
    const selector = new FakeSelector(selected(moviesLabel));
    expect(
      new SelectorDpadTargetResolver(selector).resolve(screen(capture(moviesRow, moviesPlus)), {
        label: "Movies",
      }),
    ).toEqual(moviesRow.bounds);
  });

  test("the real selector does not trade the exact Movies row for Movies Plus", () => {
    const resolver = new SelectorDpadTargetResolver(new ResolverElementSelector());
    const read = screen(capture(moviesRow, moviesPlus));
    expect(resolver.resolve(read, { label: "Movies" })).not.toEqual(
      expect.objectContaining(moviesPlus.bounds),
    );
    expect(resolver.resolve(read, { label: "Movies Plus" })).toEqual(
      expect.objectContaining(moviesPlus.bounds),
    );
  });

  test("an exact label without a focusable owner keeps tapOn's pin over a contains match", () => {
    const play = node({ bounds: FIELD_BOUNDS, text: "Play" });
    const playAll = node({
      bounds: { left: 0, top: 60, right: 20, bottom: 70 },
      text: "Play all",
      focusable: "true",
    });
    const selector = new FakeSelector(selected(play));
    expect(
      new SelectorDpadTargetResolver(selector).resolve(screen(capture(play, playAll)), {
        label: "Play",
      }),
    ).toEqual(FIELD_BOUNDS);
  });

  test("an exact focusable match beats a smaller focusable contains match", () => {
    const title = node({ bounds: FIELD_BOUNDS, text: "Play" });
    const play = node({
      bounds: { left: 0, top: 100, right: 300, bottom: 200 },
      "content-desc": "Play",
      focusable: "true",
    });
    const playAll = node({
      bounds: { left: 0, top: 60, right: 20, bottom: 70 },
      text: "Play all",
      focusable: "true",
    });
    const selector = new FakeSelector(selected(title));
    expect(
      new SelectorDpadTargetResolver(selector).resolve(screen(capture(title, playAll, play)), {
        label: "play",
      }),
    ).toEqual(play.bounds);
  });

  test("ranks focusable label matches by their real window before area", () => {
    const base = node({
      bounds: { left: 0, top: 0, right: 50, bottom: 50 },
      text: "Movies",
      focusable: "true",
    });
    const overlay = node({
      bounds: { left: 0, top: 500, right: 1000, bottom: 900 },
      text: "Movies",
      focusable: "true",
    });
    const title = node({ bounds: FIELD_BOUNDS, text: "Movies" });
    const read = screen(windowed([title, base], [overlay]));
    expect(
      new SelectorDpadTargetResolver(new FakeSelector(selected(title))).resolve(read, {
        label: "Movies",
      }),
    ).toEqual(overlay.bounds);
  });

  test("an overlay's focusable contains match outranks an exact label in a lower window", () => {
    const base = node({ bounds: FIELD_BOUNDS, text: "Movies" });
    const overlay = node({
      bounds: { left: 0, top: 500, right: 1000, bottom: 900 },
      text: "Movies Plus",
      focusable: "true",
    });
    const read = screen(windowed([base], [overlay]));
    expect(
      new SelectorDpadTargetResolver(new FakeSelector(selected(base))).resolve(read, {
        label: "Movies",
      }),
    ).toEqual(overlay.bounds);
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
