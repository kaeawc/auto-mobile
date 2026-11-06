import { describe, expect, test } from "bun:test";
import {
  pinnedFocusOptions,
  SelectorDpadTargetResolver,
} from "../../../src/features/action/DpadTargetResolver";
import type { FocusScreen } from "../../../src/features/action/FocusNavigate";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type { ElementSelectionResult, ViewHierarchyResult } from "../../../src/models";
import type { ElementQuery } from "../../../src/models/ElementQuery";
import type {
  ElementSelectionOptions,
  ElementSelector,
} from "../../../src/utils/interfaces/ElementSelector";
import { createFlatNodeForTest } from "../observe/flatHierarchyBuilders";

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
});
