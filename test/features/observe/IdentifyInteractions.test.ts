import { readFileSync } from "node:fs";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { describe, expect, test } from "bun:test";
import { IdentifyInteractions } from "../../../src/features/observe/IdentifyInteractions";
import { swipeOnSchema, tapOnSchema } from "../../../src/server/interactionTools";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { NavigationEdge } from "../../../src/utils/interfaces/NavigationGraph";
import type { Element } from "../../../src/models";

// Build a minimal Android view hierarchy whose child nodes are the interaction
// candidates. Each entry becomes a `$`-attributed node with bounds so the
// element finder and geometry accept it.
function hierarchyOf(nodes: Array<Record<string, unknown>>): ObserveResult {
  const bounds = (i: number) => ({ left: 10, top: 10 + i * 60, right: 110, bottom: 60 + i * 60 });
  return {
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            class: "android.widget.FrameLayout",
            bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
          },
          node: nodes.map((attrs, i) => ({ $: { bounds: bounds(i), ...attrs } })),
        },
      },
    },
    screenSize: { width: 1080, height: 1920 },
  } as unknown as ObserveResult;
}

const classifier = new IdentifyInteractions();

describe("IdentifyInteractions scoring characterization", () => {
  const identifiers = {
    text: "Submit",
    resourceId: "submit",
    contentDescription: "Send",
    className: "button",
  };
  const edge = (toolName: string, args: Record<string, unknown> = {}): NavigationEdge => ({
    from: "Home",
    to: "Detail",
    timestamp: 1,
    edgeType: "tool",
    interaction: { toolName, args, timestamp: 1 },
  });

  test("scores tap args by exact id or normalized text and ignores other tools' args", () => {
    expect(
      classifier["scoreEdgeMatch"](
        identifiers,
        edge("tapOn", { elementId: "submit", text: "Submit" }),
      ),
    ).toBe(0.95);
    expect(classifier["scoreEdgeMatch"](identifiers, edge("tapOn", { id: "submit" }))).toBe(0.95);
    expect(
      classifier["scoreEdgeMatch"](
        identifiers,
        edge("tapOn", { elementId: "wrong", id: "submit" }),
      ),
    ).toBe(0);
    expect(
      classifier["scoreEdgeMatch"](identifiers, edge("tapOn", { elementId: 2, id: "submit" })),
    ).toBe(0.95);
    expect(classifier["scoreEdgeMatch"](identifiers, edge("tapOn", { text: " SEND " }))).toBe(0.85);
    expect(classifier["scoreEdgeMatch"](identifiers, edge("tapOn", { text: " " }))).toBe(0);
    expect(
      classifier["scoreEdgeMatch"](identifiers, edge("swipeOn", { id: "submit", text: "Submit" })),
    ).toBe(0);
    expect(
      classifier["scoreEdgeMatch"](identifiers, { ...edge("tapOn"), interaction: undefined }),
    ).toBe(0);
  });

  test("scores selected identifiers independently and keeps the strongest score", () => {
    const selectedEdge = edge("swipeOn");
    for (const [selected, expected] of [
      [{ resourceId: "submit" }, 0.8],
      [{ text: " SUBMIT " }, 0.75],
      [{ contentDesc: " send " }, 0.7],
      [{}, 0],
      [{ resourceId: "wrong", text: "Wrong", contentDesc: "Wrong" }, 0],
    ] as const) {
      selectedEdge.interaction!.uiState = { selectedElements: [selected] };
      expect(classifier["scoreEdgeMatch"](identifiers, selectedEdge)).toBe(expected);
    }
    selectedEdge.interaction!.uiState = {
      selectedElements: [{ contentDesc: "Send" }, { text: "Submit" }, { resourceId: "submit" }],
    };
    expect(classifier["scoreEdgeMatch"](identifiers, selectedEdge)).toBe(0.8);
    expect(classifier["scoreEdgeMatch"]({ className: "button" }, selectedEdge)).toBe(0);
  });

  test("confidence retains type floors, identifier weights, boolean/string flags, and cap", () => {
    const empty: Element = {};
    for (const [type, expected] of [
      ["action", 0.6],
      ["input", 0.85],
      ["toggle", 0.8],
      ["scroll", 0.7],
      ["navigation", 0.75],
    ] as const) {
      expect(classifier["computeConfidence"](empty, type, false)).toBe(expected);
    }
    expect(
      classifier["computeConfidence"]({ clickable: true, "resource-id": "submit" }, "action", true),
    ).toBe(0.85);
    expect(
      classifier["computeConfidence"](
        { clickable: "true", "content-desc": "Send" },
        "action",
        true,
      ),
    ).toBe(0.8);
    expect(
      classifier["computeConfidence"]({ scrollable: true, "resource-id": "feed" }, "scroll", true),
    ).toBe(0.8);
    expect(
      classifier["computeConfidence"]({ scrollable: "true", text: "Home" }, "navigation", false),
    ).toBe(0.85);
    expect(
      classifier["computeConfidence"](
        { clickable: true, scrollable: true, "resource-id": "all", "content-desc": "All" },
        "action",
        true,
      ),
    ).toBe(0.99);
  });

  test("descriptions retain label precedence and every type's unlabeled form", () => {
    for (const [type, labeled, unlabeled] of [
      ["input", "Submit input field", "Input field"],
      ["toggle", "Submit toggle", "Toggle"],
      ["scroll", "Scrollable area (Submit)", "Scrollable area"],
      ["navigation", "Submit navigation", "Navigation option"],
      ["action", "Submit action", "Action"],
    ] as const) {
      expect(classifier["buildDescription"](type, identifiers)).toBe(labeled);
      expect(classifier["buildDescription"](type, { className: "button" })).toBe(unlabeled);
    }
    expect(
      classifier["buildDescription"]("action", {
        text: "",
        contentDescription: "Send",
        resourceId: "submit",
        className: "button",
      }),
    ).toBe("Send action");
    expect(
      classifier["buildDescription"]("action", { resourceId: "submit", className: "button" }),
    ).toBe("submit action");
  });

  test("builds contiguous ids, admits unlabeled scrolls, and honors optional details", () => {
    const candidates = [
      { element: { clickable: true }, hasText: false },
      { element: { scrollable: true }, typeHint: "scroll" as const, hasText: false },
      { element: { text: "Submit", clickable: true, "resource-id": "submit" }, hasText: true },
    ];
    const result = classifier["buildInteractions"](
      candidates,
      false,
      false,
      [edge("tapOn", { id: "submit" })],
      "Home",
    );
    expect(result).toEqual([
      { id: "int_1", type: "scroll", description: "Scrollable area", confidence: 0.7 },
      {
        id: "int_2",
        type: "action",
        description: "Submit action",
        confidence: 0.85,
        predictedOutcome: { type: "screen_change", destination: "Detail", confidence: 0.95 },
      },
    ]);
    const noMatch = classifier["buildInteractions"](
      candidates,
      true,
      true,
      [edge("tapOn", { text: "Other" })],
      "Home",
    );
    expect(noMatch[0].suggestedToolCall?.tool).toBe("swipeOn");
    expect(noMatch[1].element?.resourceId).toBe("submit");
    expect(noMatch[1].predictedOutcome).toBeUndefined();
    expect(
      classifier["buildInteractions"](
        candidates,
        false,
        false,
        [edge("tapOn", { id: "submit" })],
        null,
      )[1].predictedOutcome,
    ).toBeUndefined();
  });
});

describe("IdentifyInteractions", () => {
  test("returns an error when no observation is available", () => {
    const result = classifier.analyze(
      { screenSize: { width: 1080, height: 1920 } } as unknown as ObserveResult,
      { platform: "android" },
      "HomeScreen",
      [],
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("No observation available");
    expect(result.interactions).toEqual([]);
  });

  test("suggests tap (not focus) for a clickable button, and focus only for an input field", () => {
    const result = classifier.analyze(
      hierarchyOf([
        {
          class: "android.widget.Button",
          clickable: "true",
          text: "Submit",
          "resource-id": "btn_submit",
        },
        {
          class: "android.widget.EditText",
          focusable: "true",
          text: "Email",
          "resource-id": "field_email",
        },
      ]),
      { platform: "android" },
      "HomeScreen",
      [],
    );

    const button = result.interactions.find((i) => i.element?.resourceId === "btn_submit");
    const input = result.interactions.find((i) => i.element?.resourceId === "field_email");

    // A button is an action; the model must be told to tap it, not focus it.
    expect(button?.type).toBe("action");
    expect(button?.suggestedToolCall).toEqual({
      tool: "tapOn",
      params: { selector: { elementId: "btn_submit" }, action: "tap" },
    });

    // Only genuine input fields get the focus action.
    expect(input?.type).toBe("input");
    expect(input?.suggestedToolCall).toEqual({
      tool: "tapOn",
      params: { selector: { elementId: "field_email" }, action: "focus" },
    });
  });

  test("every suggested tool call validates against its registered input schema", () => {
    const result = classifier.analyze(
      hierarchyOf([
        // tapOn: elementId selector and tap action (resource ID takes precedence).
        {
          class: "android.widget.Button",
          clickable: "true",
          text: "With ID",
          "resource-id": "button_with_id",
        },
        // tapOn: text selector and tap action, including content-description fallback.
        { class: "android.widget.Button", clickable: "true", text: "Text only" },
        { class: "android.widget.Button", clickable: "true", "content-desc": "Description only" },
        // tapOn: both selector forms with focus action.
        {
          class: "android.widget.EditText",
          focusable: "true",
          text: "Input with ID",
          "resource-id": "input_with_id",
        },
        { class: "android.widget.EditText", focusable: "true", text: "Input text only" },
        // swipeOn: container elementId, text, and absent selector branches.
        { class: "android.widget.ScrollView", scrollable: "true", "resource-id": "feed" },
        { class: "android.widget.ScrollView", scrollable: "true", text: "Feed by text" },
        {
          class: "android.widget.ScrollView",
          scrollable: "true",
          "content-desc": "Feed by description",
        },
        { class: "android.widget.ScrollView", scrollable: "true" },
      ]),
      { platform: "android" },
      "HomeScreen",
      [],
    );

    const calls = result.interactions.flatMap((interaction) =>
      interaction.suggestedToolCall ? [interaction.suggestedToolCall] : [],
    );

    expect(calls).toHaveLength(9);
    for (const call of calls) {
      const schema = call.tool === "tapOn" ? tapOnSchema : swipeOnSchema;
      const parsed = schema.safeParse(call.params);
      expect(parsed.success, `${call.tool} params: ${JSON.stringify(call.params)}`).toBe(true);
    }
  });

  test("classifies 'Design system' as navigation because 'sign' is a substring (documents the false positive)", () => {
    const result = classifier.analyze(
      hierarchyOf([{ class: "android.widget.TextView", clickable: "true", text: "Design system" }]),
      { platform: "android" },
      "HomeScreen",
      [],
    );

    // "Design system" contains the nav keyword "sign", so the classifier calls
    // it navigation even though it is not. Pinned so a future keyword-matching
    // fix is a deliberate, visible change (issue #4172 item 2).
    expect(result.interactions).toHaveLength(1);
    expect(result.interactions[0].type).toBe("navigation");
    expect(result.interactions[0].description).toBe("Design system navigation");
  });

  test("limit truncates by traversal order, not by confidence", () => {
    // The input field (confidence 0.85) is the HIGHEST-confidence candidate but
    // is discovered last, so a limit of 2 drops it in favour of the two
    // lower-confidence clickables that come first in traversal order.
    const observeResult = hierarchyOf([
      {
        class: "android.widget.Button",
        clickable: "true",
        text: "Submit",
        "resource-id": "btn_submit",
      },
      { class: "android.widget.TextView", clickable: "true", text: "Design system" },
      {
        class: "android.widget.EditText",
        focusable: "true",
        text: "Email",
        "resource-id": "field_email",
      },
    ]);

    const limited = classifier.analyze(
      observeResult,
      { platform: "android", filter: { limit: 2 } },
      "HomeScreen",
      [],
    );

    expect(limited.interactions.map((i) => i.description)).toEqual([
      "Submit action",
      "Design system navigation",
    ]);
    // The higher-confidence input field is excluded purely because of order.
    expect(limited.interactions.some((i) => i.type === "input")).toBe(false);
  });

  test("predicts a screen change from a matching navigation edge (real NavigationEdge shape)", () => {
    const edge: NavigationEdge = {
      from: "HomeScreen",
      to: "DetailScreen",
      timestamp: 1_700_000_000_000,
      edgeType: "tool",
      interaction: {
        toolName: "tapOn",
        args: { id: "btn_submit" },
        timestamp: 1_700_000_000_000,
      },
    };

    const result = classifier.analyze(
      hierarchyOf([
        {
          class: "android.widget.Button",
          clickable: "true",
          text: "Submit",
          "resource-id": "btn_submit",
        },
      ]),
      { platform: "android" },
      "HomeScreen",
      [edge],
    );

    const button = result.interactions.find((i) => i.element?.resourceId === "btn_submit");
    expect(button?.predictedOutcome).toEqual({
      type: "screen_change",
      destination: "DetailScreen",
      confidence: 0.95,
    });
  });

  test("summarises interactions by type", () => {
    const result = classifier.analyze(
      hierarchyOf([
        {
          class: "android.widget.Button",
          clickable: "true",
          text: "Submit",
          "resource-id": "btn_submit",
        },
        { class: "android.widget.TextView", clickable: "true", text: "Design system" },
        {
          class: "android.widget.EditText",
          focusable: "true",
          text: "Email",
          "resource-id": "field_email",
        },
      ]),
      { platform: "android" },
      "HomeScreen",
      [],
    );

    expect(result.summary).toEqual({
      totalInteractable: 3,
      byType: { action: 1, navigation: 1, input: 1 },
      navigationOptions: 1,
      inputFields: 1,
    });
  });
});

describe("IdentifyInteractions captured Compose editability", () => {
  const resource: { contents: Array<{ text: string }> } = JSON.parse(
    readFileSync("test/fixtures/identify-interactions/playground-tap-resource.json", "utf8"),
  );
  const tapScreen: ObserveResult = JSON.parse(resource.contents[0].text);
  const fields: Pick<ObserveResult, "viewHierarchy"> = JSON.parse(
    readFileSync("test/fixtures/identify-interactions/playground-text-fields.json", "utf8"),
  );
  const parser = new DefaultElementParser();

  test("all five captured Compose buttons are tap actions without focus", () => {
    const result = classifier.analyze(tapScreen, { platform: "android" }, null, []);
    for (const id of [
      "button_regular",
      "button_elevated",
      "button_outlined",
      "button_text",
      "button_filled_tonal",
    ]) {
      const interaction = result.interactions.find((entry) => entry.element?.resourceId === id);
      expect(interaction?.element?.className).toBe("Unknown");
      expect(interaction?.type).toBe("action");
      expect(interaction?.suggestedToolCall).toEqual({
        tool: "tapOn",
        params: { selector: { elementId: id }, action: "tap" },
      });
    }
    expect(result.summary.inputFields).toBe(0);
  });

  test("real Compose TextFields with EditText and set_text semantics retain input classification", () => {
    const capturedFields = parser
      .flattenViewHierarchy(fields.viewHierarchy!)
      .filter(({ element }) => element.class === "android.widget.EditText");
    expect(capturedFields).toHaveLength(3);
    for (const { element } of capturedFields) {
      expect(element.actions).toContain("set_text");
      expect(classifier["getTypeHint"](element)).toBe("input");
      expect(classifier["classifyInteraction"](element)).toBe("input");
    }
  });

  test("set_text alone identifies an input without a class or focusability", () => {
    // Isolate an existing captured action signal without inventing a hierarchy fixture.
    const field = parser
      .flattenViewHierarchy(fields.viewHierarchy!)
      .find(({ element }) => element.class === "android.widget.EditText")!.element;
    expect(classifier["getTypeHint"]({ actions: field.actions })).toBe("input");
    expect(classifier["classifyInteraction"]({ actions: field.actions })).toBe("input");
  });

  test.each([
    { class: "android.widget.EditText" },
    { className: "ComposeTextField" },
    { class: "XCUIElementTypeTextField" },
    { class: "XCUIElementTypeSecureTextField" },
    { class: "XCUIElementTypeSearchField" },
    { class: "XCUIElementTypeTextView" },
    { password: true },
    { password: "true" },
  ])("preserves native input class and password signals %j", (element) => {
    expect(classifier["getTypeHint"](element)).toBe("input");
    expect(classifier["classifyInteraction"](element)).toBe("input");
  });

  test("focus alone on a captured button never becomes an input candidate", () => {
    const button = parser
      .flattenViewHierarchy(tapScreen.viewHierarchy!)
      .find(({ element }) => element["resource-id"] === "button_regular")!.element;
    expect(button.focusable).toBe("true");
    expect(button.clickable).toBe("true");
    expect(classifier["getTypeHint"](button)).toBeUndefined();
  });
});
