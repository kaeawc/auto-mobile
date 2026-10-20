import type {
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/server";
import { describe, expect, test } from "bun:test";
import { EarlyStartTransport } from "../../src/server/earlyStartTransport";
import { OutputGatedTransport } from "../../src/server/outputGatedTransport";

type Message = Parameters<Transport["send"]>[0];
const EXTRA_INFO: MessageExtraInfo = {
  authInfo: { token: "extra", clientId: "client", scopes: [] },
};

class FakeTransport implements Transport {
  onmessage?: Transport["onmessage"];
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  sessionId = "session";
  protocolVersion: string | undefined;
  starts = 0;
  closes = 0;
  readonly sent: Array<{ message: Message; options?: TransportSendOptions }> = [];

  async start(): Promise<void> {
    this.starts++;
  }
  async close(): Promise<void> {
    this.closes++;
    this.onclose?.();
  }
  async send(message: Message, options?: TransportSendOptions): Promise<void> {
    this.sent.push({ message, options });
  }
  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }
}

const initialize: Message = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };

describe("OutputGatedTransport", () => {
  test("delegates sends with options, start, close, session and protocol version", async () => {
    const inner = new FakeTransport();
    const logs: string[] = [];
    const gate = new OutputGatedTransport(inner, (message) => logs.push(message));
    const options = { relatedRequestId: 1 };
    await gate.start();
    await gate.send(initialize, options);
    gate.setProtocolVersion("2025-03-26");
    await gate.close();
    expect(inner.sent).toEqual([{ message: initialize, options }]);
    expect(inner.starts).toBe(1);
    expect(inner.closes).toBe(1);
    expect(gate.sessionId).toBe("session");
    expect(inner.protocolVersion).toBe("2025-03-26");
    expect(logs).toEqual([]);
  });

  test("synchronously stops sends, preserves the first reason and logs only method or response", async () => {
    const inner = new FakeTransport();
    const logs: string[] = [];
    const gate = new OutputGatedTransport(inner, (message) => logs.push(message));
    gate.stopSending("stdin closed");
    gate.stopSending("stdout write failed");
    const dropped = [
      gate.send({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
        params: { secret: "payload" },
      }),
      gate.send({ jsonrpc: "2.0", id: 1, result: { secret: "payload" } }),
      gate.send({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "payload" } }),
    ];
    expect(inner.sent).toEqual([]);
    await Promise.all(dropped);
    expect(logs).toEqual([
      "[OutputGatedTransport] Dropped notifications/tools/list_changed: stdin closed",
      "[OutputGatedTransport] Dropped response: stdin closed",
      "[OutputGatedTransport] Dropped response: stdin closed",
    ]);
  });

  test("inbound callbacks pass through even after sends stop", async () => {
    const inner = new FakeTransport();
    const gate = new OutputGatedTransport(inner, () => {});
    const received: Message[] = [];
    const errors: Error[] = [];
    let closes = 0;
    const callback: Transport["onmessage"] = (message) => received.push(message);
    gate.onmessage = callback;
    gate.onerror = (error) => errors.push(error);
    gate.onclose = () => {
      closes++;
    };
    expect(gate.onmessage).toBe(callback);
    expect<unknown>(gate.onerror).toBe(inner.onerror);
    expect<unknown>(gate.onclose).toBe(inner.onclose);
    gate.stopSending("stdin closed");
    inner.onmessage?.(initialize);
    const error = new Error("read failed");
    inner.onerror?.(error);
    await gate.close();
    expect(received).toEqual([initialize]);
    expect(errors).toEqual([error]);
    expect(closes).toBe(1);
  });

  test("a dropped send does not wait on the inner transport's backpressure", async () => {
    const inner = new FakeTransport();
    let sends = 0;
    inner.send = () => {
      sends++;
      return new Promise<never>(() => {});
    };
    const gate = new OutputGatedTransport(inner, () => {});
    gate.stopSending("stdout write failed");
    await gate.send(initialize);
    expect(sends).toBe(0);
  });

  test("as EarlyStartTransport's inner, holds initialize until attachment and silences its sends", async () => {
    const inner = new FakeTransport();
    const gate = new OutputGatedTransport(inner, () => {});
    const early = new EarlyStartTransport(gate);
    const received: Message[] = [];
    const errors: Error[] = [];
    let closes = 0;
    await early.startEarly();
    inner.onmessage?.(initialize);
    const error = new Error("read failed early");
    inner.onerror?.(error);
    inner.onclose?.();
    gate.stopSending("stdin closed");
    early.onmessage = (message) => received.push(message);
    early.onerror = (error) => errors.push(error);
    early.onclose = () => {
      closes++;
    };
    expect(received).toEqual([]);
    await early.start();
    expect(received).toEqual([initialize]);
    expect(errors).toEqual([error]);
    expect(closes).toBe(1);
    inner.onmessage?.({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(received).toHaveLength(2);
    await early.send({ jsonrpc: "2.0", id: 1, result: {} });
    expect(inner.sent).toEqual([]);
    expect(inner.starts).toBe(1);
  });
});

describe("answers-only EOF gate (#12049)", () => {
  function tracked() {
    const inner = new FakeTransport();
    const logs: string[] = [];
    const gate = new OutputGatedTransport(inner, (message) => logs.push(message));
    gate.onmessage = () => {};
    inner.onmessage?.(initialize);
    return { inner, logs, gate };
  }

  test("only received answers pass; notifications, progress, server requests and unknown ids drop", async () => {
    const { inner, logs, gate } = tracked();
    const done = gate.answerReceivedThenStop("stdin closed");
    for (const method of [
      "notifications/tools/list_changed",
      "notifications/resources/list_changed",
      "notifications/resources/updated",
      "notifications/message",
      "notifications/progress",
    ]) {
      await gate.send({ jsonrpc: "2.0", method });
      expect(logs).toContain(`[OutputGatedTransport] Dropped ${method}: stdin closed`);
    }
    await gate.send({ jsonrpc: "2.0", id: 10, method: "ping" });
    await gate.send({ jsonrpc: "2.0", id: 10, result: {} });
    expect(inner.sent).toEqual([]);
    await gate.send({ jsonrpc: "2.0", id: 1, result: {} });
    await done;
    expect(inner.sent).toHaveLength(1);
    await gate.send({ jsonrpc: "2.0", id: 1, result: {} });
    expect(inner.sent).toHaveLength(1);
  });

  test.each([false, true])(
    "waits for the final answer write to settle (reject=%s)",
    async (reject) => {
      const { inner, gate } = tracked();
      const write = Promise.withResolvers<void>();
      inner.send = () => write.promise;
      let stopped = false;
      const done = gate.answerReceivedThenStop("stdin closed");
      void done.then(() => {
        stopped = true;
      });
      const sending = gate.send({ jsonrpc: "2.0", id: 1, result: {} });
      const observed = sending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await Promise.resolve();
      expect(stopped).toBe(false);
      const error = new Error("write failed");
      if (reject) {
        write.reject(error);
      } else {
        write.resolve();
      }
      expect(await observed).toBe(reject ? error : undefined);
      await done;
      expect(stopped).toBe(true);
    },
  );

  test("an answer write begun before EOF is also awaited", async () => {
    const { inner, gate } = tracked();
    const write = Promise.withResolvers<void>();
    inner.send = () => write.promise;
    const sending = gate.send({ jsonrpc: "2.0", id: 1, result: {} });
    let stopped = false;
    const done = gate.answerReceivedThenStop("stdin closed");
    void done.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    write.resolve();
    await sending;
    await done;
    expect(stopped).toBe(true);
  });

  test("a response already answered while open is no longer received", async () => {
    const { inner, gate } = tracked();
    inner.onmessage?.({ jsonrpc: "2.0", id: "second", method: "ping" });
    await gate.send({ jsonrpc: "2.0", id: 1, result: {} });
    const done = gate.answerReceivedThenStop("stdin closed");
    await gate.send({ jsonrpc: "2.0", id: 1, result: {} });
    expect(inner.sent).toHaveLength(1);
    await gate.send({ jsonrpc: "2.0", id: "second", error: { code: -32603, message: "failed" } });
    await done;
    expect(inner.sent).toHaveLength(2);
  });

  test("stopSending wins immediately, resolves the wait and preserves its own reason", async () => {
    const { inner, gate, logs } = tracked();
    const done = gate.answerReceivedThenStop("stdin closed");
    gate.stopSending("stdout write failed");
    await done;
    await gate.send({ jsonrpc: "2.0", id: 1, result: {} });
    expect(inner.sent).toEqual([]);
    expect(logs).toContain("[OutputGatedTransport] Dropped response: stdout write failed");
  });

  test("cancelled ids are removed, including after EOF, without ignoring a pending write", async () => {
    const { inner, gate } = tracked();
    const write = Promise.withResolvers<void>();
    inner.send = () => write.promise;
    const sending = gate.send({ jsonrpc: "2.0", id: 1, result: {} });
    let stopped = false;
    const done = gate.answerReceivedThenStop("stdin closed");
    void done.then(() => {
      stopped = true;
    });
    inner.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    write.resolve();
    await sending;
    await done;
    expect(stopped).toBe(true);
  });

  test("cancel before EOF does not hold the wait; empty-set stop is synchronous and idempotent", async () => {
    const { inner, gate, logs } = tracked();
    inner.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1 },
    });
    const done = gate.answerReceivedThenStop("stdin closed");
    expect(gate.answerReceivedThenStop("different reason")).toBe(done);
    const sending = gate.send({ jsonrpc: "2.0", id: 1, result: {} });
    expect(inner.sent).toEqual([]);
    expect(logs).toEqual(["[OutputGatedTransport] Dropped response: stdin closed"]);
    await sending;
    await done;
  });

  test("reassignment and EarlyStartTransport keep request tracking and extra info", async () => {
    const inner = new FakeTransport();
    const gate = new OutputGatedTransport(inner, () => {});
    const early = new EarlyStartTransport(gate);
    await early.startEarly();
    inner.onmessage?.(initialize);
    const received: Message[] = [];
    early.onmessage = (message) => received.push(message);
    await early.start();
    const callback: Transport["onmessage"] = (message, extra) => {
      received.push(message);
      expect(extra).toEqual(EXTRA_INFO);
    };
    gate.onmessage = callback;
    expect(gate.onmessage).toBe(callback);
    inner.onmessage?.({ jsonrpc: "2.0", id: 2, method: "ping" }, EXTRA_INFO);
    const done = gate.answerReceivedThenStop("stdin closed");
    await gate.send({ jsonrpc: "2.0", id: 1, result: {} });
    await gate.send({ jsonrpc: "2.0", id: 2, result: {} });
    await done;
    expect(received).toHaveLength(2);
    expect(inner.sent).toHaveLength(2);
  });

  test("stopSending before answers-only yields the same resolved promise", async () => {
    const { gate } = tracked();
    gate.stopSending("stdout write failed");
    const done = gate.answerReceivedThenStop("stdin closed");
    expect(gate.answerReceivedThenStop("again")).toBe(done);
    await done;
  });
});
