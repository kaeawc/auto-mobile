import { beforeAll, describe, expect, test } from "bun:test";
import { getFocusedTextField } from "../../../src/features/action/ClearText";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import type { ElementBounds, ObserveResult } from "../../../src/models";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import editMenuCapture from "../../fixtures/ios-messages-compose/runner-to-edit-menu.json";
import emptyCapture from "../../fixtures/ios-messages-compose/runner-to-empty-focused.json";
import tokenCapture from "../../fixtures/ios-messages-compose/runner-to-token.json";
import trailingCapture from "../../fixtures/ios-messages-compose/runner-to-token-trailing-text.json";
import { observationFromRunnerCapture } from "../../helpers/iosRunnerCapture";

// Real iOS runner captures (iPhone 18 Pro, iOS 27.0, 2026-10-26) of the Messages new-message
// compose sheet (`simctl openurl sms:`), whose "To:" recipient field is a token field: empty and
// focused, one committed recipient token, the token plus trailing typed text, and the system
// edit menu (Paste / Select / Select All / AutoFill) over the field after a tap. The tests pin
// the structure a recipient-token recognizer (#15405) has to build on; they assert no behavior
// of the product beyond reading the capture through the production projection.
type Projected = ReturnType<SearchableHierarchy["project"]>;
type ProjectedNode = Projected[number];

let empty: Projected;
let token: Projected;
let trailing: Projected;
let menu: Projected;
let tokenObservation: ObserveResult;
let trailingObservation: ObserveResult;

function project(capture: { data: unknown }): { nodes: Projected; observation: ObserveResult } {
  const observation = observationFromRunnerCapture(capture);
  return { nodes: new SearchableHierarchy().project(observation.viewHierarchy!), observation };
}

function attributesOf(node: ProjectedNode) {
  return nodeAttributes(node.source);
}

function toField(nodes: Projected): ProjectedNode {
  const fields = nodes.filter(
    (node) => node.nativeId === "To:" && node.className === "UITextField",
  );
  expect(fields).toHaveLength(1);
  return fields[0];
}

function boundsOf(node: ProjectedNode): ElementBounds {
  const bounds: unknown = attributesOf(node).bounds;
  if (
    typeof bounds === "object" &&
    bounds !== null &&
    "left" in bounds &&
    "top" in bounds &&
    "right" in bounds &&
    "bottom" in bounds &&
    typeof bounds.left === "number" &&
    typeof bounds.top === "number" &&
    typeof bounds.right === "number" &&
    typeof bounds.bottom === "number"
  ) {
    return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
  }
  throw new Error("Captured node has no bounds");
}

function textOf(node: ProjectedNode, key: "text" | "value"): string {
  const value: unknown = attributesOf(node)[key];
  if (typeof value !== "string") {
    throw new Error(`Captured node has no ${key}`);
  }
  return value;
}

function tokensOf(nodes: Projected): ProjectedNode[] {
  const field = nodes.indexOf(toField(nodes));
  return nodes.filter((node) => node.parentIndex === field && node.className === "UIButton");
}

beforeAll(() => {
  ({ nodes: empty } = project(emptyCapture));
  ({ nodes: token, observation: tokenObservation } = project(tokenCapture));
  ({ nodes: trailing, observation: trailingObservation } = project(trailingCapture));
  ({ nodes: menu } = project(editMenuCapture));
});

describe("empty focused recipient field", () => {
  test("is a focused UITextField identified by its 'To:' label with no value or tokens", () => {
    const attributes = attributesOf(toField(empty));
    expect(attributes).toMatchObject({
      class: "UITextField",
      "resource-id": "To:",
      text: "To:",
      role: "textfield",
      clickable: "true",
      focused: "true",
      actions: ["set_text", "clear_text"],
    });
    expect(attributes.value).toBeUndefined();
    expect(tokensOf(empty)).toEqual([]);
  });

  test("keeps the static 'To:' prefix and the add-contact button as siblings of the field", () => {
    const field = toField(empty);
    const siblings = empty.filter((node) => node.parentIndex === field.parentIndex);
    const label = siblings.find((node) => node.className === "UILabel");
    const add = siblings.find((node) => node.nativeId === "ComposeRecipientAddButton");
    expect(label?.element?.text).toBe("To:");
    expect(add?.className).toBe("UIButton");
    expect(attributesOf(add!).text).toBe("Add Contact");
  });
});

describe("committed recipient token", () => {
  test("is an id-less UIButton child of the field, inside its bounds", () => {
    const field = toField(token);
    const [chip, ...rest] = tokensOf(token);
    expect(rest).toEqual([]);
    const attributes = attributesOf(chip);
    expect(attributes).toMatchObject({
      class: "UIButton",
      role: "button",
      clickable: "true",
      text: "No Name, Searching",
    });
    expect(attributes["resource-id"]).toBeUndefined();
    const inner = boundsOf(chip);
    const outer = boundsOf(field);
    expect(inner.left).toBeGreaterThanOrEqual(outer.left);
    expect(inner.right).toBeLessThanOrEqual(outer.right);
    expect(inner.top).toBeGreaterThanOrEqual(outer.top);
    expect(inner.bottom).toBeLessThanOrEqual(outer.bottom);
  });

  test("shows up in the field value as the token label plus a separating space", () => {
    const chip = tokensOf(token)[0];
    const value = textOf(toField(token), "value");
    expect(value).toBe(`${textOf(chip, "text")} `);
    expect(getFocusedTextField(tokenObservation.viewHierarchy!)).toMatchObject({
      value,
      secure: false,
    });
  });

  test("keeps the same token node when text is typed after it", () => {
    const before = tokensOf(token)[0];
    const after = tokensOf(trailing)[0];
    expect(attributesOf(after)["view-id"]).toBe(attributesOf(before)["view-id"]);
    expect(tokensOf(trailing)).toHaveLength(1);
  });
});

describe("token followed by trailing typed text", () => {
  test("reads as token label + space + the uncommitted text in the field value", () => {
    const label = textOf(tokensOf(trailing)[0], "text");
    const value = textOf(toField(trailing), "value");
    expect(value).toBe(`${label} ab`);
    expect(value.slice(label.length).trim()).toBe("ab");
    expect(getFocusedTextField(trailingObservation.viewHierarchy!)).toMatchObject({
      value,
      secure: false,
    });
  });
});

describe("system edit menu over the field", () => {
  const ITEMS = ["Paste", "Select", "Select All", "AutoFill"];

  test("lists its actions as plain UIView rows in a UICollectionView below the field", () => {
    const field = boundsOf(toField(menu));
    const rows = ITEMS.map((text) => {
      const row = menu.find((node) => node.className === "UIView" && node.element?.text === text);
      expect(row).toBeDefined();
      return row!;
    });
    for (const row of rows) {
      expect(menu[row.parentIndex!].className).toBe("UICollectionView");
      expect(attributesOf(row).clickable).toBeUndefined();
      expect(boundsOf(row).top).toBeGreaterThanOrEqual(field.bottom);
    }
    expect(new Set(rows.map((row) => row.parentIndex)).size).toBe(1);
  });

  test("does not appear in the frames captured without the menu", () => {
    for (const nodes of [empty, token, trailing]) {
      expect(nodes.some((node) => node.element?.text === "Paste")).toBe(false);
    }
  });

  test("leaves the field focused with its token and trailing text intact", () => {
    expect(attributesOf(toField(menu))).toMatchObject({
      focused: "true",
      value: attributesOf(toField(trailing)).value,
    });
    expect(tokensOf(menu)).toHaveLength(1);
  });
});
