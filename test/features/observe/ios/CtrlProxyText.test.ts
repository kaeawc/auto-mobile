import { describe, expect, test } from "bun:test";
import { CtrlProxyText } from "../../../../src/features/observe/ios/CtrlProxyText";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

describe("CtrlProxyText requestAppendText", () => {
  const flush = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

  test("sends the append command and resolves its normalized result", async () => {
    const harness = createIosDelegateHarness({ supportedCommands: ["request_append_text"] });
    const pending = new CtrlProxyText(harness.context).requestAppendText("a");
    await flush();

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]).toMatchObject({ type: "request_append_text", text: "a" });
    expect(harness.resolveLast({ success: true, totalTimeMs: 1 })).toBe(true);
    await expect(pending).resolves.toEqual({ success: true, totalTimeMs: 1 });
  });

  test("returns the actionable capability error without sending to a stale runner", async () => {
    const harness = createIosDelegateHarness({ supportedCommands: ["request_set_text"] });

    await expect(new CtrlProxyText(harness.context).requestAppendText("a")).resolves.toEqual({
      success: false,
      totalTimeMs: 0,
      error: "request_append_text is not supported by the connected device service",
    });
    expect(harness.sentMessages).toEqual([]);
  });
});
