import { describe, expect, test } from "bun:test";
import { createFocusIdentity } from "../../../src/features/action/FocusIdentity";
import type { FocusPathEntry, FocusScreen } from "../../../src/features/action/FocusNavigate";
import type { FocusNavigateDirection } from "../../../src/features/action/FocusNavigateDirections";
import type { Element } from "../../../src/models/Element";

const BOUNDS = { left: 0, top: 400, right: 1920, bottom: 520 };

/** One read of a one-slot control: nothing sits outside it, so only its label can change. */
function read(label: string): { entry: FocusPathEntry; screen: FocusScreen } {
  const focused: Element = {
    bounds: BOUNDS,
    "resource-id": "slot",
    text: label,
    focusable: true,
    class: "android.widget.TextView",
  };
  return {
    entry: { bounds: BOUNDS, resourceId: "slot", text: label },
    screen: { focused, elements: [focused] },
  };
}

function keys(steps: ReadonlyArray<[string, FocusNavigateDirection | undefined]>) {
  const identify = createFocusIdentity();
  return steps.map(([label, pressed]) => {
    const { entry, screen } = read(label);
    return identify(entry, screen, pressed);
  });
}

describe("createFocusIdentity toggle detection (#17209)", () => {
  test("a label changed by right and changed back by left is an in-place toggle", () => {
    const ids = keys([
      ["50%", undefined],
      ["51%", "right"],
      ["50%", "left"],
    ]);
    expect(ids[2]).toMatchObject({ changedInPlace: true });
    expect(ids[2]?.key).toStartWith("adjustable|");
  });

  test("a toggle still counts when a refused press sits between the two changes", () => {
    const ids = keys([
      ["50%", undefined],
      ["51%", "right"],
      ["51%", "down"],
      ["50%", "left"],
    ]);
    expect(ids[3]).toMatchObject({ changedInPlace: true });
  });

  test("a label that comes back on the same press is a list moving, not a toggle", () => {
    const ids = keys([
      ["A", undefined],
      ["B", "down"],
      ["A", "down"],
      ["C", "down"],
    ]);
    expect(ids.map((id) => id.changedInPlace)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(new Set(ids.map((id) => id.key)).size).toBe(3);
  });
});
