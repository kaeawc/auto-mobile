import { describe, expect, test } from "bun:test";
import type { SendKeysCommand } from "../../../src/features/action/SendKeys";
import { createSendKeysFocusHarness } from "./SendKeysTestHarness";

const commands: SendKeysCommand[] = [{ action: "type", text: "hello" }];

describe("sendKeys target (#9305)", () => {
  test("target reaches the selector focus before any text is sent", async () => {
    const h = createSendKeysFocusHarness();
    const result = await h.action.execute(
      commands,
      { elementId: "field" },
      undefined,
      undefined,
      undefined,
      { target: "app" },
    );

    expect(result.success).toBe(true);
    expect(h.focusCalls).toHaveLength(1);
    expect(h.focusCalls[0].options).toMatchObject({ target: "app" });
    expect(h.calls[0]).toBe("focus");
  });

  test("target without a selector is rejected before anything is sent", async () => {
    const h = createSendKeysFocusHarness();
    const result = await h.action.execute(commands, undefined, undefined, undefined, undefined, {
      target: "overlay",
    });

    expect(result).toMatchObject({
      success: false,
      completedCommands: 0,
      error: "target requires a selector naming the field to focus",
    });
    expect(h.calls).toEqual([]);
  });
});
