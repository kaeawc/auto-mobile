import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { attachRawViewHierarchy } from "../../../src/features/utility/viewHierarchySearch";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";
import type { Element } from "../../../src/models/Element";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";

const editableElement = (focus: Record<string, unknown>) => ({
  text: "Phone number",
  class: "android.widget.EditText",
  "resource-id": "com.example:id/phone",
  bounds: { left: 0, top: 0, right: 100, bottom: 40 },
  ...focus,
});

afterEach(() => serverConfig.setRawElementSearchEnabled(false));

function loadFocusCapture(moment: "pre" | "post"): ViewHierarchyResult {
  const capture: { viewHierarchy: ViewHierarchyResult } = JSON.parse(
    readFileSync(
      new URL(
        `../../fixtures/android-focus/playground-text-field-${moment}-tap.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  return capture.viewHierarchy;
}

function capturedFocusSelection() {
  const selection = new ResolverElementSelector().selectByText(
    loadFocusCapture("pre"),
    "Basic Text Field",
    { intentAction: "focus-input" },
  );
  if (!selection.element) {
    throw new Error("Captured Basic Text Field did not resolve to an input");
  }
  expect(selection.element.class).toBe("android.widget.EditText");
  expect(selection.element.bounds).toEqual({ left: 84, top: 1115, right: 996, bottom: 1262 });
  expect(selection.element["view-id"]).toBe("s2-0a67f33121084cd4");
  expect(selection.element.text).toBeUndefined();
  expect(selection.matchedElement?.text).toBe("Basic Text Field");
  return { ...selection, element: selection.element };
}

async function executeFocus(
  element: Element,
  postTapHierarchy: ViewHierarchyResult = { hierarchy: { node: {} } },
  elementId?: string,
  matchedElement?: Element,
  index?: number,
  testTag?: string,
  postSelectedIndex?: number,
  options: Partial<TapOnElementOptions> = {},
) {
  const fakeSelector = new FakeElementSelector(element);
  if (matchedElement || index !== undefined) {
    fakeSelector.setNextSelection({
      element,
      matchedElement,
      indexInMatches: index,
      totalMatches: index === undefined ? 1 : index + 1,
    });
  }
  let tapped = false;
  const tapOnElement = new TapOnElement(
    {
      name: "test-device",
      platform: "android",
      deviceId: "emulator-5554",
    } as any,
    new FakeAdbClient() as any,
    {
      timer: new FakeTimer(),
      elementSelector: fakeSelector,
      tapStrategy: {
        isAccessibilityServiceEnabled: async () => false,
        shouldRunPreTapStability: () => false,
      } as any,
      selectionStateTracker: { finalize: async () => [] } as any,
    },
  );
  const observation = { viewHierarchy: postTapHierarchy };
  (tapOnElement as any).observedInteraction = async (
    action: (currentObservation: typeof observation) => Promise<Record<string, unknown>>,
  ) => {
    const actionResult = await action({ viewHierarchy: { hierarchy: { node: {} } } });
    if (index !== undefined || postSelectedIndex !== undefined) {
      const resolvedIndex = index ?? postSelectedIndex ?? 0;
      const matches = new SearchableHierarchy()
        .project(postTapHierarchy)
        .filter(
          (node) =>
            node.element &&
            (elementId
              ? node.element["resource-id"] === elementId
              : testTag
                ? node.element["test-tag"] === testTag
                : node.element.text === element.text),
        );
      fakeSelector.setNextSelection({
        element: matches[resolvedIndex]?.element ?? null,
        indexInMatches: resolvedIndex,
        totalMatches: matches.length,
      });
    }
    return { ...actionResult, observation };
  };
  (tapOnElement as any).executeAndroidTap = async () => {
    tapped = true;
  };
  (tapOnElement as any).prepareSelectionCapture = async () => null;
  (tapOnElement as any).deriveTapEffectAfterPostTapObservation = async (
    _previousObservation: unknown,
    currentObservation: typeof observation,
  ) => ({ observation: currentObservation });
  (tapOnElement as any).captureTerminalObservationScreenshot = async () => {};
  (tapOnElement as any).recordDeferredPredictionOutcome = async () => {};
  (tapOnElement as any).enforceFreshnessConsistencyWithEffect = () => {};

  const result = await tapOnElement.execute({
    ...(elementId
      ? { elementId, index, action: "focus" }
      : testTag
        ? { testTag, index, action: "focus" }
        : { text: "Phone", index, action: "focus" }),
    ...options,
    action: "focus",
  });
  return { result, tapped, fakeSelector };
}

describe("TapOnElement selectionStrategy", () => {
  test("passes selectionStrategy to the element selector", () => {
    const fakeSelector = new FakeElementSelector({
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    } as any);
    const tapOnElement = new TapOnElement(
      {
        name: "test-device",
        platform: "android",
        deviceId: "emulator-5554",
      } as any,
      new FakeAdbClient() as any,
      {
        timer: new FakeTimer(),
        elementSelector: fakeSelector,
      },
    );

    const result = (tapOnElement as any).findElementInHierarchy(
      {
        text: "Match",
        action: "tap",
        selectionStrategy: "random",
      },
      { hierarchy: { node: {} } },
    );

    expect(result.selection.element).not.toBeNull();
    expect(fakeSelector.lastText).toBe("Match");
    expect(fakeSelector.lastStrategy).toBe("random");
  });

  test("uses input-focused text selection only for focus actions", () => {
    const fakeSelector = new FakeElementSelector({
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    } as any);
    const tapOnElement = new TapOnElement(
      {
        name: "test-device",
        platform: "android",
        deviceId: "emulator-5554",
      } as any,
      new FakeAdbClient() as any,
      {
        timer: new FakeTimer(),
        elementSelector: fakeSelector,
      },
    );

    (tapOnElement as any).findElementInHierarchy(
      { text: "Match", action: "tap" },
      { hierarchy: { node: {} } },
    );
    expect(fakeSelector.lastTextSelectionIntent).toBe("tap");

    (tapOnElement as any).findElementInHierarchy(
      { textAny: ["Match"], action: "focus" },
      { hierarchy: { node: {} } },
    );
    expect(fakeSelector.lastTextSelectionIntent).toBe("focus-input");
  });

  test("fails focus on a non-editable match without tapping it", async () => {
    const fakeSelector = new FakeElementSelector({
      text: "Phone notification: ",
      class: "android.widget.TextView",
      bounds: { left: 0, top: 0, right: 10, bottom: 10 },
    } as any);
    const tapOnElement = new TapOnElement(
      {
        name: "test-device",
        platform: "android",
        deviceId: "emulator-5554",
      } as any,
      new FakeAdbClient() as any,
      { timer: new FakeTimer(), elementSelector: fakeSelector },
    );
    let tapped = false;
    (tapOnElement as any).observedInteraction = async (action: (observation: unknown) => unknown) =>
      action({ viewHierarchy: { hierarchy: { node: {} } } });
    (tapOnElement as any).executeAndroidTap = async () => {
      tapped = true;
    };

    const result = await tapOnElement.execute({ text: "Phone", action: "focus" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Phone notification");
    expect(tapped).toBe(false);
  });

  test("does not treat a selected editable target as already keyboard-focused", async () => {
    const { result, tapped } = await executeFocus(editableElement({ selected: "true" }));

    expect(tapped).toBe(true);
    expect(result.wasAlreadyFocused).toBeUndefined();
    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to confirm focus");
  });

  test("keeps a genuinely keyboard-focused editable target verified", async () => {
    const { result, tapped } = await executeFocus(
      editableElement({ focused: "true", selected: "false" }),
    );

    expect(tapped).toBe(false);
    expect(result.wasAlreadyFocused).toBe(true);
    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test.each(["resource ID", "test tag", "text"] as const)(
    "rejects focus on the first occurrence after tapping the second field with the same %s (#7787)",
    async (identifier) => {
      const identity =
        identifier === "resource ID"
          ? { "resource-id": "com.example:id/phone" }
          : { "resource-id": undefined, "test-tag": "shared" };
      const first = editableElement({ ...identity, focused: true });
      const second = editableElement({
        ...identity,
        focused: false,
        bounds: { left: 0, top: 80, right: 100, bottom: 120 },
      });
      const { result, tapped } = await executeFocus(
        second,
        { hierarchy: { node: [first, second] } },
        identifier === "resource ID" ? "com.example:id/phone" : undefined,
        undefined,
        1,
        identifier === "test tag" ? "shared" : undefined,
      );

      expect(tapped).toBe(true);
      expect(result.selectedElement?.indexInMatches).toBe(1);
      expect(result.focusVerified).toBe(false);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to confirm focus");
    },
  );

  test("verifies the selected second occurrence when it actually receives focus (#7787)", async () => {
    const first = editableElement({ focused: false });
    const second = editableElement({
      focused: false,
      bounds: { left: 0, top: 80, right: 100, bottom: 120 },
    });
    const { result, tapped } = await executeFocus(
      second,
      { hierarchy: { node: [first, { ...second, focused: true }] } },
      "com.example:id/phone",
      undefined,
      1,
    );

    expect(tapped).toBe(true);
    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test("verifies the selected shared-ID occurrence after it shifts vertically (#7787)", async () => {
    const first = editableElement({ focused: false });
    const second = editableElement({
      focused: false,
      bounds: { left: 0, top: 480, right: 100, bottom: 520 },
    });
    const shifted = {
      ...second,
      focused: true,
      bounds: { left: 0, top: 80, right: 100, bottom: 140 },
    };
    const { result, tapped } = await executeFocus(
      second,
      { hierarchy: { node: [first, shifted] } },
      "com.example:id/phone",
      undefined,
      1,
    );

    expect(tapped).toBe(true);
    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test.each([false, true])(
    "checks the selected shared-ID occurrence without an explicit index (focused: %s)",
    async (selectedFocused) => {
      const first = editableElement({
        bounds: { left: 0, top: 480, right: 100, bottom: 520 },
        focused: false,
      });
      const postFirst = {
        ...first,
        bounds: { left: 0, top: 80, right: 100, bottom: 140 },
        focused: selectedFocused,
      };
      const second = editableElement({
        bounds: { left: 0, top: 180, right: 100, bottom: 220 },
        focused: !selectedFocused,
      });
      const { result } = await executeFocus(
        first,
        { hierarchy: { node: [postFirst, second] } },
        "com.example:id/phone",
        undefined,
        undefined,
        undefined,
        0,
      );

      expect(result.focusVerified).toBe(selectedFocused);
      expect(result.success).toBe(selectedFocused);
    },
  );

  test("verifies a uniquely identified field after it moves up and grows on focus", async () => {
    const before = editableElement({
      bounds: { left: 0, top: 480, right: 100, bottom: 520 },
      focused: false,
    });
    const after = {
      ...before,
      bounds: { left: 0, top: 80, right: 100, bottom: 140 },
      focused: true,
    };
    const otherFocused = editableElement({
      "resource-id": "com.example:id/search",
      text: "Search",
      bounds: { left: 0, top: 160, right: 100, bottom: 200 },
      focused: true,
    });
    const { result, tapped } = await executeFocus(
      before,
      { hierarchy: { node: [after, otherFocused] } },
      "com.example:id/phone",
    );

    expect(tapped).toBe(true);
    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test("verifies a unique Compose test tag after a 400px shift, growth, and s2 ID churn", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "test-tag": "email-input",
      "view-id": "s2-before",
      bounds: { left: 0, top: 480, right: 100, bottom: 520 },
      focused: false,
    });
    const after = {
      ...before,
      "view-id": "s2-after",
      bounds: { left: 0, top: 80, right: 100, bottom: 140 },
      focused: true,
    };
    const otherFocused = editableElement({
      "resource-id": undefined,
      "test-tag": "search-input",
      "view-id": "s2-search",
      text: "Search",
      bounds: { left: 0, top: 160, right: 100, bottom: 200 },
      focused: true,
    });
    const { result, tapped } = await executeFocus(
      before,
      { hierarchy: { node: [after, otherFocused] } },
      undefined,
      undefined,
      undefined,
      "email-input",
    );

    expect(tapped).toBe(true);
    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test("verifies focus after an s2 id changes on the post-tap Compose field (#7758)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-35973cc76070aa26",
      focused: false,
    });
    const after = {
      ...before,
      "view-id": "s2-7e6d952ea5fe0ddf",
      focused: true,
      node: [{ text: "Email" }],
    };
    const { result, tapped } = await executeFocus(
      before,
      { hierarchy: { node: after } },
      "s2-35973cc76070aa26",
    );

    expect(tapped).toBe(true);
    expect(result.success).toBe(true);
    expect(result.focusVerified).toBe(true);
  });

  const emptyComposeField = (properties: Partial<Element> = {}): Element => ({
    class: "android.widget.EditText",
    text: "Basic Text Field",
    bounds: { left: 84, top: 1115, right: 996, bottom: 1262 },
    focused: false,
    ...properties,
  });

  test.each([
    { name: "unscoped", options: {} },
    {
      name: "container + unique",
      options: { container: { text: "Basic Text Fields" }, selectionStrategy: "unique" as const },
    },
  ])(
    "verifies empty Compose field after its merged label disappears ($name, #8997)",
    async ({ options }) => {
      for (const text of ["", undefined]) {
        const before = emptyComposeField();
        const after = emptyComposeField({
          text,
          focused: true,
          node: [
            { class: "android.widget.TextView", text: "Basic Text Field", bounds: before.bounds },
          ],
        });
        const { result, tapped, fakeSelector } = await executeFocus(
          before,
          { hierarchy: { node: after } },
          undefined,
          before,
          undefined,
          undefined,
          undefined,
          { text: "Basic Text Field", ...options },
        );

        expect(tapped).toBe(true);
        expect(result.focusVerified).toBe(true);
        expect(result.success).toBe(true);
        expect(fakeSelector.lastStrategy).toBe(options.selectionStrategy);
        expect(fakeSelector.textCalls).toEqual(["Basic Text Field"]);
      }
    },
  );

  test.each([
    {
      name: "different bounds",
      fields: [
        emptyComposeField({
          text: "",
          focused: true,
          bounds: { left: 84, top: 1300, right: 996, bottom: 1447 },
        }),
      ],
    },
    {
      name: "two focused fields",
      fields: [
        emptyComposeField({ text: "", focused: true }),
        emptyComposeField({
          text: "",
          focused: true,
          bounds: { left: 84, top: 1300, right: 996, bottom: 1447 },
        }),
      ],
    },
    {
      name: "two same-bounds focused fields",
      fields: [
        emptyComposeField({ text: "", focused: true }),
        emptyComposeField({ text: "", focused: true }),
      ],
    },
    {
      name: "two same-bounds editable candidates",
      fields: [emptyComposeField({ text: "", focused: true }), emptyComposeField({ text: "" })],
    },
    {
      name: "different editable class",
      fields: [
        emptyComposeField({
          text: "",
          focused: true,
          class: "android.widget.AutoCompleteTextView",
        }),
      ],
    },
    {
      name: "changed stable resource ID",
      fields: [
        emptyComposeField({ text: "", focused: true, "resource-id": "com.example:id/other" }),
      ],
    },
    {
      name: "a stable view ID on a replacement",
      fields: [emptyComposeField({ text: "", focused: true, "view-id": "other-field" })],
    },
    {
      name: "a test tag on a replacement",
      fields: [emptyComposeField({ text: "", focused: true, "test-tag": "other-field" })],
    },
  ])("rejects empty Compose focus with $name (#8997)", async ({ fields }) => {
    const before = emptyComposeField();
    const { result, tapped } = await executeFocus(
      before,
      { hierarchy: { node: fields } },
      undefined,
      before,
      undefined,
      undefined,
      undefined,
      { text: "Basic Text Field" },
    );

    expect(tapped).toBe(true);
    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to confirm focus");
  });

  test("verifies the captured empty Compose field across deserialized roots and s2 ID churn (#9017)", async () => {
    const before = capturedFocusSelection();
    const capture = loadFocusCapture("post");
    const fields = new SearchableHierarchy()
      .project(capture)
      .filter((node) => node.element?.["view-id"] === "s2-ee780752c005afb8");
    expect(fields).toHaveLength(2);
    expect(fields[0].source).not.toBe(fields[1].source);
    expect(fields[0].rootGroup).not.toBe(fields[1].rootGroup);
    const { result, tapped } = await executeFocus(
      before.element,
      capture,
      undefined,
      before.matchedElement,
      undefined,
      undefined,
      undefined,
      { text: "Basic Text Field" },
    );
    expect(tapped).toBe(true);
    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test.each([
    "focus disagreement",
    "Email also focused",
    "different class",
    "different stable ID",
    "different bounds",
  ])("rejects captured Compose focus with %s across roots (#9017)", async (difference) => {
    const before = capturedFocusSelection();
    const capture = loadFocusCapture("post");
    const nodes = new SearchableHierarchy().project(capture);
    const field = nodes.find((node) => node.element?.["view-id"] === "s2-ee780752c005afb8")!;
    const attributes = nodeAttributes(field.source);
    if (difference === "focus disagreement") {
      attributes.focused = "false";
    }
    if (difference === "different class") {
      attributes.class = "android.widget.AutoCompleteTextView";
    }
    if (difference === "different stable ID") {
      attributes["view-id"] = "s2-other-field";
    }
    if (difference === "different bounds") {
      field.source.bounds = [84, 1120, 996, 1267];
    }
    if (difference === "Email also focused") {
      const emailFields = nodes.filter(
        (node) => node.className === "android.widget.EditText" && node.bounds?.top === 1283,
      );
      expect(emailFields).toHaveLength(2);
      for (const email of emailFields) {
        nodeAttributes(email.source).focused = "true";
      }
    }
    const { result, tapped } = await executeFocus(
      before.element,
      capture,
      undefined,
      before.matchedElement,
      undefined,
      undefined,
      undefined,
      { text: "Basic Text Field" },
    );
    expect(tapped).toBe(true);
    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to confirm focus");
  });

  test.each(["view-id", "test-tag"] as const)(
    "verifies an unchanged %s duplicated across deserialized roots (#9017)",
    async (key) => {
      const before = editableElement({
        "resource-id": undefined,
        [key]: "field-id",
        focused: false,
      });
      const capture: ViewHierarchyResult = JSON.parse(
        JSON.stringify({
          hierarchy: { node: { ...before, focused: true } },
          windows: [{ windowLayer: 1, hierarchy: { ...before, focused: true } }],
        }),
      );
      const { result } = await executeFocus(
        before,
        capture,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { selectionStrategy: "unique" },
      );
      expect(result.focusVerified).toBe(true);
      expect(result.success).toBe(true);
    },
  );

  test("verifies an empty Compose field within the bounds epsilon despite linked roots and s2 ID churn (#8997)", async () => {
    const before = emptyComposeField({ "view-id": "s2-before" });
    const after = emptyComposeField({
      text: undefined,
      focused: true,
      "view-id": "s2-after",
      bounds: { left: 87, top: 1118, right: 999, bottom: 1265 },
    });
    const { result } = await executeFocus(
      before,
      { hierarchy: { node: after }, windows: [{ windowLayer: 1, hierarchy: after }] },
      undefined,
      before,
      undefined,
      undefined,
      undefined,
      { text: "Basic Text Field" },
    );

    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test("verifies focus on an empty EditText when its s2 id is unchanged (PR #7780 review)", async () => {
    const before = editableElement({
      text: undefined,
      "resource-id": undefined,
      "view-id": "s2-empty-compose-input",
      focused: false,
      node: [{ text: "Email" }],
    });
    const after = { ...before, focused: true };
    const { result, tapped } = await executeFocus(
      before,
      { hierarchy: { node: after } },
      "s2-empty-compose-input",
    );

    expect(tapped).toBe(true);
    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test("verifies focus when the IME pans a field vertically without changing its horizontal extent (PR #7780 review)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-before",
      bounds: { left: 0, top: 400, right: 100, bottom: 440 },
      focused: false,
    });
    const after = {
      ...before,
      "view-id": "s2-after",
      bounds: { left: 0, top: 100, right: 100, bottom: 140 },
      focused: true,
    };
    const { result } = await executeFocus(before, { hierarchy: { node: after } });

    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test("verifies focus on a label-promoted ancestor using the matched label's text (PR #7780 review)", async () => {
    const before = editableElement({
      text: undefined,
      "resource-id": undefined,
      "view-id": "s2-before",
      bounds: { left: 0, top: 400, right: 100, bottom: 440 },
      focused: false,
    });
    const after = {
      ...before,
      text: "Phone number",
      "view-id": "s2-after",
      bounds: { left: 0, top: 100, right: 100, bottom: 140 },
      focused: true,
    };
    const label = { text: "Phone number", class: "android.widget.TextView", bounds: before.bounds };
    const { result } = await executeFocus(before, { hierarchy: { node: after } }, undefined, label);

    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test("deduplicates a focused field that appears twice via linked window roots (PR #7780 review)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-before",
      bounds: { left: 0, top: 400, right: 100, bottom: 440 },
      focused: false,
    });
    const focusedNode = {
      ...before,
      "view-id": "s2-after",
      bounds: { left: 0, top: 100, right: 100, bottom: 140 },
      focused: true,
    };
    const viewHierarchy = {
      hierarchy: { node: focusedNode },
      windows: [{ windowLayer: 1, hierarchy: focusedNode }],
    };
    const { result } = await executeFocus(before, viewHierarchy);

    expect(result.focusVerified).toBe(true);
    expect(result.success).toBe(true);
  });

  test("rejects a same-bounds replacement field lacking a stable identity match (PR #7780 review)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-before",
      focused: false,
    });
    const after = {
      ...before,
      text: "Email",
      "view-id": "s2-after",
      focused: true,
    };
    const { result } = await executeFocus(before, { hierarchy: { node: after } });

    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
  });

  test("rejects a different field with the same class but a different hint when focus verification runs (PR #7780 review)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-before",
      bounds: { left: 0, top: 400, right: 100, bottom: 440 },
      focused: false,
    });
    const after = {
      ...before,
      text: "Email",
      "view-id": "s2-after",
      bounds: { left: 0, top: 100, right: 100, bottom: 140 },
      focused: true,
    };
    const { result } = await executeFocus(before, { hierarchy: { node: after } });

    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to confirm focus");
  });

  test("rejects an IME-panned field with a different stable resource ID (PR #7780 review)", async () => {
    const before = editableElement({
      "view-id": "s2-before",
      bounds: { left: 0, top: 400, right: 100, bottom: 440 },
      focused: false,
    });
    const after = {
      ...before,
      "resource-id": "com.example:id/email",
      "view-id": "s2-after",
      bounds: { left: 0, top: 100, right: 100, bottom: 140 },
      focused: true,
    };
    const { result } = await executeFocus(before, { hierarchy: { node: after } });

    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
  });

  test("rejects an ambiguous IME pan when two editable fields report focus (PR #7780 review)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-before",
      bounds: { left: 0, top: 400, right: 100, bottom: 440 },
      focused: false,
    });
    const focused = {
      ...before,
      "view-id": "s2-after",
      bounds: { left: 0, top: 100, right: 100, bottom: 140 },
      focused: true,
    };
    const anotherFocused = {
      ...focused,
      text: "Email",
      "view-id": "s2-other",
      bounds: { left: 0, top: 150, right: 100, bottom: 190 },
    };
    const { result } = await executeFocus(before, {
      hierarchy: { node: [focused, anotherFocused] },
    });

    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
  });

  test("verifies focus against the attached raw hierarchy when raw element search is enabled (PR #7780 review)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-before",
      focused: false,
    });
    const after = { ...before, "view-id": "s2-after", focused: true };
    const filtered = { hierarchy: { node: { text: "Visible sibling" } } };
    const raw = { hierarchy: { node: after } };
    attachRawViewHierarchy(filtered, raw);
    serverConfig.setRawElementSearchEnabled(true);

    const project = spyOn(SearchableHierarchy.prototype, "project");
    try {
      const { result, tapped } = await executeFocus(before, filtered);

      expect(tapped).toBe(true);
      expect(result.success).toBe(true);
      expect(result.focusVerified).toBe(true);
      expect(project.mock.calls.at(-1)?.[0]).toBe(raw);
    } finally {
      project.mockRestore();
    }
  });

  test("does not accept keyboard focus on a different editable field (#7758)", async () => {
    const before = editableElement({
      "resource-id": undefined,
      "view-id": "s2-35973cc76070aa26",
      focused: false,
    });
    const after = {
      ...before,
      text: "Email",
      "view-id": "s2-7e6d952ea5fe0ddf",
      bounds: { left: 0, top: 80, right: 100, bottom: 120 },
      focused: true,
    };
    const { result } = await executeFocus(
      before,
      { hierarchy: { node: after } },
      "s2-35973cc76070aa26",
    );
    expect(result.focusVerified).toBe(false);
    expect(result.success).toBe(false);
  });
});
