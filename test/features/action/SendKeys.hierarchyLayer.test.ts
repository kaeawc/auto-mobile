import { describe, expect, test } from "bun:test";
import type { SendKeysCommand } from "../../../src/features/action/SendKeys";
import { createSendKeysFocusHarness } from "./SendKeysTestHarness";

const commands: SendKeysCommand[] = [{ action: "type", text: "hello" }];

describe("sendKeys layer (#9305)", () => {
  test("layer reaches the selector focus before any text is sent", async () => {
    const h = createSendKeysFocusHarness();
    const result = await h.action.execute(
      commands,
      { elementId: "field" },
      undefined,
      undefined,
      undefined,
      { layer: "app" },
    );

    expect(result.success).toBe(true);
    expect(h.focusCalls).toHaveLength(1);
    expect(h.focusCalls[0].options).toMatchObject({ layer: "app" });
    expect(h.calls[0]).toBe("focus");
  });

  test("layer without a selector is rejected before anything is sent", async () => {
    const h = createSendKeysFocusHarness();
    const result = await h.action.execute(commands, undefined, undefined, undefined, undefined, {
      layer: "prototype",
    });

    expect(result).toMatchObject({
      success: false,
      completedCommands: 0,
      error: "layer requires a selector naming the field to focus",
    });
    expect(h.calls).toEqual([]);
  });
});
