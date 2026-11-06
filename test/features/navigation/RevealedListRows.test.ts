import { describe, expect, test } from "bun:test";
import { RevealedListRows } from "../../../src/features/navigation/RevealedListRows";
import type { Element } from "../../../src/models";
import { createObserveResultForTest } from "../observe/flatHierarchyBuilders";

const RAIL = { left: 0, top: 100, right: 900, bottom: 400 };

function card(index: number, left: number): Element {
  return {
    bounds: { left, top: 100, right: left + 300, bottom: 400 },
    "resource-id": `app:id/show_${index}`,
    text: `Show ${index}`,
  };
}

const focusedOn = (element: Element) => createObserveResultForTest({ focusedElement: element });

function railWithShow3Revealed(): RevealedListRows {
  const rows = new RevealedListRows();
  rows.remember(RAIL, "right", ["app:id/show_3|Show 3|"]);
  return rows;
}

describe("RevealedListRows.railDirectionFor", () => {
  test("walks along the rail to a card an advance revealed", () => {
    expect(railWithShow3Revealed().railDirectionFor(card(3, 600), focusedOn(card(2, 300)))).toBe(
      "right",
    );
  });

  test("keeps the rail's direction when focus already rests on the revealed card", () => {
    const show3 = card(3, 600);
    expect(railWithShow3Revealed().railDirectionFor(show3, focusedOn(show3))).toBe("right");
  });

  test("accumulates rows across advances of the same rail", () => {
    const rows = railWithShow3Revealed();
    rows.remember({ ...RAIL }, "right", ["app:id/show_4|Show 4|"]);
    expect(rows.railDirectionFor(card(4, 600), focusedOn(card(3, 300)))).toBe("right");
    expect(rows.railDirectionFor(card(3, 300), focusedOn(card(3, 300)))).toBe("right");
  });

  test("leaves a card that was on screen before any advance to the default walk", () => {
    expect(
      railWithShow3Revealed().railDirectionFor(card(1, 0), focusedOn(card(1, 0))),
    ).toBeUndefined();
  });

  test("leaves a row revealed in a vertical list to the default downward scan", () => {
    const rows = new RevealedListRows();
    rows.remember({ left: 0, top: 100, right: 400, bottom: 400 }, "down", [
      "app:id/item_3|Item 3|",
    ]);
    const item3: Element = {
      bounds: { left: 0, top: 300, right: 400, bottom: 400 },
      "resource-id": "app:id/item_3",
      text: "Item 3",
    };
    expect(rows.railDirectionFor(item3, focusedOn(item3))).toBeUndefined();
  });

  test("does not press along the rail when focus is outside it", () => {
    const header: Element = {
      bounds: { left: 0, top: 0, right: 900, bottom: 100 },
      "resource-id": "app:id/header",
    };
    expect(
      railWithShow3Revealed().railDirectionFor(card(3, 600), focusedOn(header)),
    ).toBeUndefined();
  });

  test("does not press along the rail when the card is behind focus", () => {
    expect(
      railWithShow3Revealed().railDirectionFor(card(3, 0), focusedOn(card(5, 600))),
    ).toBeUndefined();
  });

  test("forgets every rail on clear", () => {
    const rows = railWithShow3Revealed();
    rows.clear();
    expect(rows.railDirectionFor(card(3, 600), focusedOn(card(2, 300)))).toBeUndefined();
  });
});
