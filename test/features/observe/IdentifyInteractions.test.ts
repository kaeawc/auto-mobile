import { describe, expect, test } from "bun:test";
import { IdentifyInteractions } from "../../../src/features/observe/IdentifyInteractions";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { NavigationEdge } from "../../../src/utils/interfaces/NavigationGraph";

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
      params: { id: "btn_submit", action: "tap" },
    });

    // Only genuine input fields get the focus action.
    expect(input?.type).toBe("input");
    expect(input?.suggestedToolCall).toEqual({
      tool: "tapOn",
      params: { id: "field_email", action: "focus" },
    });
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
