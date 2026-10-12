import { describe, expect, test } from "bun:test";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import { EarlyStartTransport } from "../../src/server/earlyStartTransport";
import { OutputGatedTransport } from "../../src/server/outputGatedTransport";

type Message = Parameters<Transport["send"]>[0];

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
    gate.onmessage = (message) => received.push(message);
    gate.onerror = (error) => errors.push(error);
    gate.onclose = () => {
      closes++;
    };
    expect(gate.onmessage).toBe(inner.onmessage);
    expect(gate.onerror).toBe(inner.onerror);
    expect(gate.onclose).toBe(inner.onclose);
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
