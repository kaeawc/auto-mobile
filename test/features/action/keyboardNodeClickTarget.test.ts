import { expect, test } from "bun:test";
import type { Element, ViewHierarchyResult } from "../../../src/models";
import { keyboardNodeClickTargetError } from "../../../src/features/action/keyboardNodeClickTarget";

const bounds = { left: 10, top: 20, right: 210, bottom: 120 };
const editText = {
  focused: "true",
  class: "android.widget.EditText",
  "resource-id": "com.example:id/notes",
  bounds,
};
const focusedElement: Element = {
  bounds,
  class: editText.class,
  "resource-id": editText["resource-id"],
};
const supported = async () => true;

function hierarchyOf(...nodes: Array<Record<string, unknown>>): ViewHierarchyResult {
  return { hierarchy: { node: { $: {}, node: nodes.map(($) => ({ $ })) } } };
}

test("accepts a selector that names exactly the focused editable field", async () => {
  const error = await keyboardNodeClickTargetError(
    { resourceId: "com.example:id/notes" },
    hierarchyOf(editText),
    focusedElement,
    supported,
  );
  expect(error).toBeUndefined();
});

test("matches a short resource id the way the runner does", async () => {
  const error = await keyboardNodeClickTargetError(
    { resourceId: "notes" },
    hierarchyOf(editText),
    focusedElement,
    supported,
  );
  expect(error).toBeUndefined();
});

test("rejects a unique selector whose node is not the focused editable field", async () => {
  const error = await keyboardNodeClickTargetError(
    { resourceId: "com.example:id/notes" },
    hierarchyOf({ ...editText, focused: "false" }),
    focusedElement,
    supported,
  );
  expect(error).toBe("Node selector does not resolve to the focused text input");
});

test("rejects a unique selector whose node sits elsewhere than the focused field", async () => {
  const error = await keyboardNodeClickTargetError(
    { resourceId: "com.example:id/notes" },
    hierarchyOf({ ...editText, bounds: { ...bounds, top: 300, bottom: 400 } }),
    focusedElement,
    supported,
  );
  expect(error).toBe("Node selector does not resolve to the focused text input");
});

test("rejects a selector that matches nothing in the hierarchy", async () => {
  const error = await keyboardNodeClickTargetError(
    { testTag: "missing" },
    hierarchyOf(editText),
    focusedElement,
    supported,
  );
  expect(error).toBe("Node selector matches no element in the current hierarchy");
});

test("rejects a selector that needs node-selector support the runner lacks", async () => {
  const error = await keyboardNodeClickTargetError(
    { testTag: "notes" },
    hierarchyOf({ ...editText, "test-tag": "notes" }),
    focusedElement,
    async () => false,
  );
  expect(error).toBe("Runner does not support stable node selectors");
});

test("rejects a missing hierarchy", async () => {
  const error = await keyboardNodeClickTargetError(
    { resourceId: "com.example:id/notes" },
    null,
    focusedElement,
    supported,
  );
  expect(error).toContain("incomplete hierarchy");
});
