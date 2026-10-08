import { describe, expect, test } from "bun:test";
import { OVERLAY_NODE_TYPES } from "../../../src/features/overlay/overlaySpec";
import { validateOverlaySpec } from "../../../src/features/overlay/overlayValidation";

function spec(state: Record<string, string | number | boolean>, node: unknown) {
  return {
    id: "a",
    window: { placement: { type: "fullscreen" } },
    state,
    root: { type: "column", children: [node] },
  };
}
const options = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
];

describe("radioGroup, listItem and button extras (#10439)", () => {
  test("the new node types are registered", () => {
    expect(OVERLAY_NODE_TYPES).toContain("radioGroup");
    expect(OVERLAY_NODE_TYPES).toContain("listItem");
  });

  test("a radio group requires a string state key", () => {
    const result = validateOverlaySpec(
      spec({ k: 1 }, { type: "radioGroup", stateKey: "k", options }),
    );
    expect(result).toEqual({
      success: false,
      error: {
        path: "root.children[0].stateKey",
        message: "Radio group requires a string state key",
      },
    });
  });

  test("radio option values must be unique", () => {
    const result = validateOverlaySpec(
      spec({ k: "a" }, { type: "radioGroup", stateKey: "k", options: [options[0], options[0]] }),
    );
    expect(result).toEqual({
      success: false,
      error: { path: "root.children[0].options[1].value", message: "Duplicate radio option value" },
    });
  });

  test("a list item's trailing toggle requires a boolean state key", () => {
    const result = validateOverlaySpec(
      spec(
        { k: "on" },
        { type: "listItem", headline: "H", trailing: { type: "switch", stateKey: "k" } },
      ),
    );
    expect(result).toEqual({
      success: false,
      error: {
        path: "root.children[0].trailing.stateKey",
        message: "Toggle control requires a boolean state key",
      },
    });
  });

  test("tonal and elevated buttons with a leading icon validate", () => {
    for (const variant of ["tonal", "elevated"]) {
      const result = validateOverlaySpec(
        spec({}, { type: "button", label: "Go", variant, icon: "check" }),
      );
      expect(result.success).toBe(true);
    }
  });
});
