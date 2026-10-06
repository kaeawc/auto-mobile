import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
import { CtrlProxyClipboard } from "../../../../src/features/observe/ios/CtrlProxyClipboard";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

describe("CtrlProxyClipboard dispatch acknowledgement", () => {
  test.each(["timeout", "refusal", "success", "socket closed", "abort", "structured refusal"])(
    "%s after a written frame",
    async (outcome) => {
      const h = createIosDelegateHarness();
      const controller = new AbortController();
      let dispatches = 0;
      const pending = new CtrlProxyClipboard(h.context).requestClipboard(
        "paste",
        undefined,
        5000,
        undefined,
        controller.signal,
        () => {
          expect(h.sentMessages).toHaveLength(1);
          dispatches++;
        },
      );
      await flush();
      expect(dispatches).toBe(1);
      if (outcome === "timeout") {
        h.advanceTime(5000);
      } else if (outcome === "socket closed") {
        h.requestManager.reject(h.lastRequestId()!, new Error("socket closed"));
      } else if (outcome === "structured refusal") {
        h.requestManager.reject(h.lastRequestId()!, new ActionableError("runner refused"));
      } else if (outcome === "abort") {
        controller.abort(new Error("cancelled"));
      } else {
        h.resolveLast({ success: outcome === "success", error: "runner reply", totalTimeMs: 0 });
      }
      const result = await pending;
      expect(result.success).toBe(outcome === "success");
      expect(result.acknowledged).toBe(
        outcome === "refusal" || outcome === "success" || outcome === "structured refusal",
      );
      expect(h.requestManager.getPendingIds()).toEqual([]);
    },
  );

  test("already aborted sends no frame and invokes no dispatch marker", async () => {
    const h = createIosDelegateHarness();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    let dispatches = 0;
    await expect(
      new CtrlProxyClipboard(h.context).requestClipboard(
        "paste",
        undefined,
        5000,
        undefined,
        controller.signal,
        () => {
          dispatches++;
        },
      ),
    ).rejects.toBe(reason);
    expect(h.sentMessages).toEqual([]);
    expect(dispatches).toBe(0);
  });

  test("socket write failure does not invoke the dispatch marker", async () => {
    const h = createIosDelegateHarness();
    h.context.getWebSocket = () => null;
    let dispatches = 0;
    const result = await new CtrlProxyClipboard(h.context).requestClipboard(
      "paste",
      undefined,
      5000,
      undefined,
      undefined,
      () => {
        dispatches++;
      },
    );
    expect(result.success).toBe(false);
    expect(result.acknowledged).toBe(false);
    expect(dispatches).toBe(0);
    expect(h.sentMessages).toEqual([]);
  });
});
