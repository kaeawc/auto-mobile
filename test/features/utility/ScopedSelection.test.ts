import { expect, test } from "bun:test";
import {
  isStrictlyScoped,
  propagateUniqueStrategy,
} from "../../../src/features/utility/ScopedSelection";
import { scopedSelectionMatrix } from "../../helpers/scopedSelectionMatrix";

for (const row of scopedSelectionMatrix) {
  test(`shared scope policies: ${row.name}`, () => {
    expect(isStrictlyScoped(row)).toBe(row.nested);
    expect(isStrictlyScoped(row, "nested-container-defined")).toBe(row.nested);
    expect(isStrictlyScoped(row, "any-container")).toBe(row.anyContainer);
    expect(isStrictlyScoped(row.container, "swipe-container-options")).toBe(row.swipeContainer);
    expect(isStrictlyScoped(row, "swipe-look-for-options")).toBe(row.swipeLookFor);
  });
  if (row.container) {
    test(`unique propagation: ${row.name}`, () => {
      const container = row.container!;
      const before = structuredClone(container);
      const result = propagateUniqueStrategy(container, row.selectionStrategy);
      expect(result.selectionStrategy).toBe(
        row.selectionStrategy === "unique" ? "unique" : container.selectionStrategy,
      );
      expect(container).toEqual(before);
      expect(result.container).toBe(container.container);
      if (row.selectionStrategy !== "unique") {
        expect(result).toBe(container);
      }
    });
  }
}

test("absent selection does not opt into any scope policy", () => {
  for (const policy of [
    "nested-container",
    "nested-container-defined",
    "any-container",
    "swipe-container-options",
    "swipe-look-for-options",
  ] as const) {
    expect(isStrictlyScoped(undefined, policy)).toBe(false);
  }
});
