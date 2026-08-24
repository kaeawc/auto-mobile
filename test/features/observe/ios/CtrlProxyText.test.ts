import { describe, expect, test } from "bun:test";
import { CtrlProxyText } from "../../../../src/features/observe/ios/CtrlProxyText";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

describe("CtrlProxyText requestAppendText", () => {
  const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

  test("sends the append command and resolves its normalized result", async () => {
    const harness = createIosDelegateHarness({ supportedCommands: ["request_append_text"] });
    const pending = new CtrlProxyText(harness.context).requestAppendText("a");
    await flush();

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]).toMatchObject({ type: "request_append_text", text: "a" });
    expect(harness.resolveLast({ success: true, totalTimeMs: 1 })).toBe(true);
    await expect(pending).resolves.toEqual({ success: true, totalTimeMs: 1 });
  });

  test("includes a frame context when supplied", async () => {
    const harness = createIosDelegateHarness({ supportedCommands: ["request_append_text"] });
    const pending = new CtrlProxyText(harness.context).requestAppendText(
      "a",
      5000,
      undefined,
      "ios:7",
    );
    await flush();

    expect(harness.sentMessages[0]).toMatchObject({
      type: "request_append_text",
      text: "a",
      frameContext: "ios:7",
    });
    expect(harness.resolveLast({ success: true, totalTimeMs: 1 })).toBe(true);
    await expect(pending).resolves.toEqual({ success: true, totalTimeMs: 1 });
  });

  test("falls back to focused-field typeText on a runner that predates append", async () => {
    const harness = createIosDelegateHarness({ supportedCommands: ["request_set_text"] });
    const pending = new CtrlProxyText(harness.context).requestAppendText("a");
    await flush();

    expect(harness.sentMessages).toEqual([
      expect.objectContaining({ type: "request_set_text", text: "a" }),
    ]);
    expect(harness.resolveLast({ success: true, totalTimeMs: 1 })).toBe(true);
    await expect(pending).resolves.toEqual({ success: true, totalTimeMs: 1 });
  });

  test("waits for a stale runner handshake before choosing the compatibility command", async () => {
    const harness = createIosDelegateHarness();
    const handshake = new Promise<string[]>((resolve) => {
      harness.timer.setTimeout(() => resolve(["request_set_text"]), 50);
    });
    const text = new CtrlProxyText({
      ...harness.context,
      getSupportedCommands: () => handshake,
    });

    const pending = text.requestAppendText("a");
    await flush();
    expect(harness.sentMessages).toEqual([]);

    harness.advanceTime(50);
    await flush();
    expect(harness.sentMessages).toEqual([
      expect.objectContaining({ type: "request_set_text", text: "a" }),
    ]);
    expect(harness.resolveLast({ success: true, totalTimeMs: 1 })).toBe(true);
    await expect(pending).resolves.toEqual({ success: true, totalTimeMs: 1 });
  });
});
