import { describe, expect, test } from "bun:test";
import { CtrlProxyText } from "../../../../src/features/observe/ios/CtrlProxyText";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

describe("iOS text transport safety", () => {
  const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

  for (const operation of ["append", "set", "clear", "legacyAppend"] as const) {
    const start = (h: ReturnType<typeof createIosDelegateHarness>) => {
      const client = new CtrlProxyText(h.context);
      return operation === "set"
        ? client.requestSetText("hello")
        : operation === "clear"
          ? client.requestClearText()
          : client.requestAppendText("hello");
    };
    const harness = () =>
      createIosDelegateHarness({
        supportedCommands: operation === "legacyAppend" ? ["request_set_text"] : undefined,
      });

    test(`${operation}: dispatched timeout is indeterminate`, async () => {
      const h = harness();
      const pending = start(h);
      await flush();
      h.advanceTime(5000);
      const result = await pending;
      expect(result).toMatchObject({ success: false, retryable: false });
      expect(result.error).toContain("outcome is indeterminate");
      expect(result.error).toContain("Do not retry automatically. Observe before retrying.");
      expect(h.sentMessages).toHaveLength(1);
    });

    test(`${operation}: connection drop after dispatch is indeterminate`, async () => {
      const h = harness();
      const pending = start(h);
      await flush();
      h.requestManager.cancelAll(new Error("runner disconnected"));
      const result = await pending;
      expect(result).toMatchObject({ success: false, retryable: false });
      expect(result.error).toContain("outcome is indeterminate");
      expect(result.error).toContain("runner disconnected");
    });

    test(`${operation}: no connection stays a plain failure`, async () => {
      const h = harness();
      h.setConnected(false);
      expect(await start(h)).toEqual({ success: false, totalTimeMs: 0, error: "Not connected" });
      expect(h.sentMessages).toHaveLength(0);
    });

    test(`${operation}: failed send stays a plain failure`, async () => {
      const h = harness();
      const socket = h.context.getWebSocket()!;
      socket.send = () => {
        throw new Error("send failed");
      };
      const result = await start(h);
      expect(result.success).toBe(false);
      expect(result.error).toContain("send failed");
      expect(result.error).not.toContain("indeterminate");
      expect(result.retryable).toBeUndefined();
    });
  }

  test.each([false, true])("long text survives 5000ms (legacy=%s)", async (legacy) => {
    const h = createIosDelegateHarness({
      supportedCommands: legacy ? ["request_set_text"] : undefined,
    });
    const pending = new CtrlProxyText(h.context).requestAppendText("a".repeat(1000));
    await flush();
    h.advanceTime(5000);
    expect(h.requestManager.getPendingCount()).toBe(1);
    h.resolveLast({ success: true, totalTimeMs: 5001 });
    await expect(pending).resolves.toEqual({ success: true, totalTimeMs: 5001 });
  });

  test("set text also scales its default timeout", async () => {
    const h = createIosDelegateHarness();
    const pending = new CtrlProxyText(h.context).requestSetText("a".repeat(1000));
    await flush();
    h.advanceTime(5000);
    expect(h.requestManager.getPendingCount()).toBe(1);
    h.resolveLast({ success: true, totalTimeMs: 5001 });
    await expect(pending).resolves.toEqual({ success: true, totalTimeMs: 5001 });
  });

  test.each(["append", "legacyAppend", "set", "clear"] as const)(
    "%s forwards dispatch and clamps after connection work",
    async (operation) => {
      const h = createIosDelegateHarness({
        supportedCommands: operation === "legacyAppend" ? ["request_set_text"] : undefined,
      });
      const text = new CtrlProxyText({
        ...h.context,
        ensureConnected: async () => {
          h.advanceTime(1000);
          return true;
        },
      });
      let dispatches = 0;
      const options = {
        deadlineMs: h.timer.now() + 4000,
        onDispatch: () => {
          dispatches++;
        },
      };
      const pending =
        operation === "set"
          ? text.requestSetText("a".repeat(1000), options)
          : operation === "clear"
            ? text.requestClearText(undefined, undefined, undefined, options)
            : text.requestAppendText("a".repeat(1000), undefined, undefined, undefined, options);
      await flush();
      expect(dispatches).toBe(1);
      h.advanceTime(2999);
      expect(h.requestManager.getPendingCount()).toBe(1);
      h.advanceTime(1);
      expect(await pending).toMatchObject({ success: false, retryable: false, totalTimeMs: 3000 });
    },
  );

  test("expired deadline during handshake prevents append dispatch", async () => {
    const h = createIosDelegateHarness();
    const text = new CtrlProxyText({
      ...h.context,
      getSupportedCommands: async () => {
        h.advanceTime(10);
        return ["request_append_text"];
      },
    });
    const result = await text.requestAppendText("a", undefined, undefined, undefined, {
      deadlineMs: h.timer.now() + 5,
    });
    expect(result).toEqual({
      success: false,
      totalTimeMs: 0,
      error: "Request deadline expired before dispatch",
    });
    expect(h.sentMessages).toHaveLength(0);
  });

  test.each(["append", "legacyAppend", "set", "clear"] as const)(
    "%s cancels pending requests after dispatch without encouraging a retry",
    async (operation) => {
      const h = createIosDelegateHarness({
        supportedCommands: operation === "legacyAppend" ? ["request_set_text"] : undefined,
      });
      const text = new CtrlProxyText(h.context);
      const controller = new AbortController();
      const options = { abortSignal: controller.signal };
      const pending =
        operation === "set"
          ? text.requestSetText("hello", options)
          : operation === "clear"
            ? text.requestClearText(undefined, undefined, undefined, options)
            : text.requestAppendText("hello", undefined, undefined, undefined, options);
      await flush();
      controller.abort();
      expect(await pending).toMatchObject({ success: false, retryable: false });
      expect(h.requestManager.getPendingCount()).toBe(0);
      expect(h.sentMessages).toHaveLength(1);
    },
  );

  test("abort during connection prevents dispatch and stays plain", async () => {
    const h = createIosDelegateHarness();
    const controller = new AbortController();
    const text = new CtrlProxyText({
      ...h.context,
      ensureConnected: async () => {
        controller.abort();
        return true;
      },
    });
    const result = await text.requestSetText("hello", { abortSignal: controller.signal });
    expect(result.error).toContain("aborted before dispatch");
    expect(result.retryable).toBeUndefined();
    expect(h.sentMessages).toHaveLength(0);
  });

  test("confirmed runner failure stays plain", async () => {
    const h = createIosDelegateHarness();
    const pending = new CtrlProxyText(h.context).requestAppendText("hello");
    await flush();
    const failure = { success: false, totalTimeMs: 1, error: "runner_busy" };
    h.resolveLast(failure);
    await expect(pending).resolves.toEqual(failure);
  });
});

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
