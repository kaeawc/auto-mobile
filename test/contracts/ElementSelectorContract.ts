import { describe, expect, test } from "bun:test";
import type { ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import type { ElementSelector } from "../../src/utils/interfaces/ElementSelector";

/** What the contract drives: a selector plus a way to say whether the next query should match. */
export interface ElementSelectorContractHarness {
  selector: ElementSelector;
  /** A capture the selector is given; the real side resolves queries against it. */
  capture: ViewHierarchyResult;
  /** Text that resolves to at least one element in `capture`. */
  presentText: string;
  /** Text that resolves to nothing in `capture`. */
  absentText: string;
  /** Script the next selection to hit (`true`) or miss (`false`); a no-op for the real side. */
  arm(hit: boolean): void;
}

/**
 * Shared behavioural contract for {@link ElementSelector} (#11868): the fake and the real
 * ResolverElementSelector run the same scenarios. The real side resolves against a captured
 * Android hierarchy, so a hit is a genuine ElementResolver match.
 */
export function runElementSelectorContract(
  name: string,
  make: () => ElementSelectorContractHarness,
): void {
  describe(`ElementSelector contract: ${name}`, () => {
    test("a hit reports the element, a match count and an in-range index", () => {
      const { selector, capture, presentText, arm } = make();
      arm(true);
      const result = selector.select(capture, { text: presentText });
      expect(result.element).not.toBeNull();
      expect(result.totalMatches).toBeGreaterThanOrEqual(1);
      expect(result.indexInMatches).toBeGreaterThanOrEqual(0);
      expect(result.indexInMatches).toBeLessThan(result.totalMatches);
    });

    test("a miss reports no element, zero matches and index -1", () => {
      const { selector, capture, absentText, arm } = make();
      arm(false);
      const result = selector.select(capture, { text: absentText });
      expect(result).toMatchObject({ element: null, totalMatches: 0, indexInMatches: -1 });
    });

    test("the strategy defaults to first and an explicit one is echoed", () => {
      const { selector, capture, presentText, arm } = make();
      arm(true);
      expect(selector.select(capture, { text: presentText }).strategy).toBe("first");
      expect(selector.select(capture, { text: presentText }, { strategy: "random" }).strategy).toBe(
        "random",
      );
    });

    test("index 0 selects the first match", () => {
      const { selector, capture, presentText, arm } = make();
      arm(true);
      const result = selector.select(capture, { text: presentText }, { index: 0 });
      expect(result.element).not.toBeNull();
      expect(result.indexInMatches).toBe(0);
    });

    test("an out-of-range index selects nothing and reports index -1", () => {
      const { selector, capture, presentText, arm } = make();
      arm(true);
      const result = selector.select(capture, { text: presentText }, { index: 999 });
      expect(result.element).toBeNull();
      expect(result.indexInMatches).toBe(-1);
    });

    test("the deprecated selectByText adapter agrees with select", () => {
      const { selector, capture, presentText, absentText, arm } = make();
      arm(true);
      expect(selector.selectByText(capture, presentText).element).not.toBeNull();
      arm(false);
      expect(selector.selectByText(capture, absentText)).toMatchObject({
        element: null,
        totalMatches: 0,
        indexInMatches: -1,
      });
    });
  });
}
