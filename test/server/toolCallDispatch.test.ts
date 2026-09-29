import { describe, expect, test } from "bun:test";
import {
  createProgressEcho,
  dispatchToolCall,
  type ToolCall,
  type ToolCallBackend,
  type ToolCallExtra,
  type ToolCallProgressNotification,
  type ToolCallRequest,
} from "../../src/server/toolCallDispatch";

/**
 * Unit coverage for the one `tools/call` envelope every live topology installs
 * (issue #6545): name/argument extraction, the missing-name guard, and the
 * client progress-token echo (#6118/#6205).
 */

class FakeExtra implements ToolCallExtra {
  readonly sent: ToolCallProgressNotification[] = [];
  failSend = false;

  constructor(readonly _meta?: { progressToken?: string | number }) {}

  async sendNotification(notification: ToolCallProgressNotification): Promise<void> {
    if (this.failSend) {
      throw new Error("Transport disconnected");
    }
    this.sent.push(notification);
  }
}

class RecordingBackend implements ToolCallBackend<ToolCallRequest, FakeExtra, string> {
  readonly progressFailureMessage = "progress failed";
  readonly events: string[] = [];
  calls: ToolCall<FakeExtra>[] = [];

  prepare(request: ToolCallRequest): void {
    this.events.push("prepare");
    request.params.arguments = { ...request.params.arguments, prepared: true };
  }

  async execute(call: ToolCall<FakeExtra>): Promise<string> {
    this.events.push("execute");
    this.calls.push(call);
    return `ran ${call.name}`;
  }
}

describe("dispatchToolCall", () => {
  test("prepares the request, then hands the backend its name and arguments", async () => {
    const backend = new RecordingBackend();
    const extra = new FakeExtra();

    const result = await dispatchToolCall(
      { params: { name: "probe", arguments: { value: 1 } } },
      extra,
      backend,
    );

    expect(result).toBe("ran probe");
    expect(backend.events).toEqual(["prepare", "execute"]);
    expect(backend.calls[0].args).toEqual({ value: 1, prepared: true });
    expect(backend.calls[0].extra).toBe(extra);
  });

  test("defaults omitted arguments to an empty object", async () => {
    const backend = new RecordingBackend();
    backend.prepare = () => {};

    await dispatchToolCall({ params: { name: "probe" } }, new FakeExtra(), backend);

    expect(backend.calls[0].args).toEqual({});
  });

  test("rejects a missing tool name before the backend runs", async () => {
    const backend = new RecordingBackend();

    await expect(dispatchToolCall({ params: {} }, new FakeExtra(), backend)).rejects.toThrow(
      "Tool name is missing in the request",
    );
    expect(backend.events).toEqual(["prepare"]);
  });

  test("passes no progress callback or token when the client sent none", async () => {
    const backend = new RecordingBackend();

    await dispatchToolCall({ params: { name: "probe" } }, new FakeExtra({}), backend);

    expect(backend.calls[0].progress).toBeUndefined();
    expect(backend.calls[0].progressToken).toBeUndefined();
  });

  test("passes the client's own token and an echo that uses it", async () => {
    const backend = new RecordingBackend();
    const extra = new FakeExtra({ progressToken: "client-token" });

    await dispatchToolCall({ params: { name: "probe" } }, extra, backend);
    await backend.calls[0].progress?.(1, 2, "halfway");

    expect(backend.calls[0].progressToken).toBe("client-token");
    expect(extra.sent).toEqual([
      {
        method: "notifications/progress",
        params: { progressToken: "client-token", progress: 1, total: 2, message: "halfway" },
      },
    ]);
  });
});

describe("createProgressEcho", () => {
  test("returns undefined without a client token, so none is fabricated (#6118)", () => {
    expect(createProgressEcho(new FakeExtra({}), "unused")).toBeUndefined();
    expect(createProgressEcho(new FakeExtra(), "unused")).toBeUndefined();
  });

  test("echoes a numeric token and omits an empty message", async () => {
    const extra = new FakeExtra({ progressToken: 7 });

    await createProgressEcho(extra, "unused")?.(3);

    expect(extra.sent).toEqual([
      {
        method: "notifications/progress",
        params: { progressToken: 7, progress: 3, total: undefined },
      },
    ]);
  });

  test("swallows a failed send so the tool call is not failed", async () => {
    const extra = new FakeExtra({ progressToken: "t" });
    extra.failSend = true;

    await expect(createProgressEcho(extra, "progress failed")!(1, 2)).resolves.toBeUndefined();
  });
});
