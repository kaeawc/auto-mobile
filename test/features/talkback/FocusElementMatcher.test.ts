import { describe, expect, test } from "bun:test";
import { FocusElementMatcher } from "../../../src/features/talkback/FocusElementMatcher";
import type { Element } from "../../../src/models/Element";

/**
 * findCurrentFocusIndex resolves the TalkBack cursor's position in the traversal
 * order by trying identifiers in a fixed precedence:
 *   1. resource-id  2. test-tag  3. content-desc  4. text  5. bounds.
 *
 * Each rung must win over the ones below it. These rows pin that order by giving
 * the current-focus element a strong identifier that points at one traversal
 * entry while a weaker identifier (shared with a DIFFERENT entry) would resolve
 * elsewhere — so a dropped rung resolves the cursor to the wrong row.
 */
describe("FocusElementMatcher.findCurrentFocusIndex", () => {
  const matcher = new FocusElementMatcher();

  const boundsAt = (i: number) => ({ left: i, top: i, right: i + 5, bottom: i + 5 });

  test("returns null when there is no current focus", () => {
    expect(
      matcher.findCurrentFocusIndex(null, [{ "resource-id": "a", bounds: boundsAt(0) }]),
    ).toBeNull();
  });

  test("returns null when the traversal order is empty", () => {
    expect(
      matcher.findCurrentFocusIndex({ "resource-id": "a", bounds: boundsAt(0) }, []),
    ).toBeNull();
  });

  // Each row: an ordered traversal list, the current-focus element, and the index
  // the cursor should resolve to via the named rung.
  test.each([
    [
      "resource-id wins",
      [
        { "resource-id": "row-0", "content-desc": "shared", text: "shared", bounds: boundsAt(0) },
        { "resource-id": "row-1", "content-desc": "shared", text: "shared", bounds: boundsAt(1) },
      ] as Element[],
      {
        "resource-id": "row-1",
        "content-desc": "shared",
        text: "shared",
        bounds: boundsAt(9),
      } as Element,
      1,
    ],
    [
      "test-tag wins when resource-id is absent",
      [
        { "test-tag": "tag-0", "content-desc": "shared", bounds: boundsAt(0) },
        { "test-tag": "tag-1", "content-desc": "shared", bounds: boundsAt(1) },
      ] as Element[],
      { "test-tag": "tag-1", "content-desc": "shared", bounds: boundsAt(9) } as Element,
      1,
    ],
    [
      "content-desc wins when resource-id and test-tag are absent",
      [
        { "content-desc": "desc-0", text: "shared", bounds: boundsAt(0) },
        { "content-desc": "desc-1", text: "shared", bounds: boundsAt(1) },
      ] as Element[],
      { "content-desc": "desc-1", text: "shared", bounds: boundsAt(9) } as Element,
      1,
    ],
    [
      "text wins when only text and bounds identify the element",
      [
        { text: "text-0", bounds: boundsAt(0) },
        { text: "text-1", bounds: boundsAt(1) },
      ] as Element[],
      { text: "text-1", bounds: boundsAt(9) } as Element,
      1,
    ],
    [
      "bounds are the last resort when no identifiers are present",
      [{ bounds: boundsAt(0) }, { bounds: boundsAt(1) }] as Element[],
      { bounds: boundsAt(1) } as Element,
      1,
    ],
  ])("%s", (_label, elements, currentFocus, expectedIndex) => {
    expect(matcher.findCurrentFocusIndex(currentFocus as Element, elements as Element[])).toBe(
      expectedIndex as number,
    );
  });
});
