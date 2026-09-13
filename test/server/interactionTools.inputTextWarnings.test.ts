import { afterEach, describe, expect, test } from "bun:test";
import {
  inputTextHandler,
  resetInputTextFactory,
  setInputTextFactory,
} from "../../src/server/interactionTools";
import type { InputTextArgs } from "../../src/server/interactionToolTypes";
import type { BootedDevice, SendTextResult } from "../../src/models";

// #6868: `inputText` with `dismissKeyboard: true` returned `isError: true` with
// "a11y input completed but keyboard dismissal failed: ..." even though the text
// had landed — so the only way to learn the call worked was to parse English
// prose, and a client that treats isError as fatal aborted a task that was fine.
// A failed best-effort epilogue now degrades to a `warnings[]` entry plus
// `keyboardDismissed: false` on a SUCCESSFUL response; `isError` is reserved for
// a failed text write.
describe("inputTextHandler (registered handler wiring, #6868)", () => {
  const device = { deviceId: "fake", platform: "android" } as unknown as BootedDevice;
  const args: InputTextArgs = { text: "5125550147", dismissKeyboard: true, platform: "android" };

  type ToolResponse = { isError?: true; content: Array<{ type: string; text: string }> };

  const parsePayload = (response: ToolResponse) =>
    JSON.parse(response.content[0].text) as {
      message: string;
      success: boolean;
      error?: string;
      warnings?: string[];
      keyboardDismissed?: boolean;
    };

  const stubInputText = (result: SendTextResult): void => {
    setInputTextFactory(() => ({ execute: async () => result }));
  };

  afterEach(() => {
    resetInputTextFactory();
  });

  test("a dismissal-only failure is a success carrying a warning, not an error", async () => {
    stubInputText({
      success: true,
      text: "5125550147",
      keyboardDismissed: false,
      warnings: ["keyboard dismissal failed: Failed to close keyboard"],
    });

    const response = (await inputTextHandler(device, args)) as ToolResponse;

    expect(response.isError).toBeUndefined();
    const payload = parsePayload(response);
    expect(payload.success).toBe(true);
    expect(payload.error).toBeUndefined();
    expect(payload.keyboardDismissed).toBe(false);
    expect(payload.warnings).toEqual(["keyboard dismissal failed: Failed to close keyboard"]);
    expect(payload.message).toBe("Input text");
  });

  test("a confirmed dismissal reports keyboardDismissed with no warnings", async () => {
    stubInputText({ success: true, text: "5125550147", keyboardDismissed: true });

    const response = (await inputTextHandler(device, args)) as ToolResponse;

    expect(response.isError).toBeUndefined();
    const payload = parsePayload(response);
    expect(payload.keyboardDismissed).toBe(true);
    expect(payload.warnings).toBeUndefined();
  });

  test("a failed text write is still an error", async () => {
    stubInputText({
      success: false,
      text: "5125550147",
      error: "Accessibility service setText failed: no focused field",
    });

    const response = (await inputTextHandler(device, args)) as ToolResponse;

    expect(response.isError).toBe(true);
    expect(parsePayload(response).message).toBe(
      "Failed to input text: Accessibility service setText failed: no focused field",
    );
  });
});
