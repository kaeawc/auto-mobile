import { describe, expect, test } from "bun:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { EarlyStartTransport } from "../../src/server/earlyStartTransport";

type Message = Parameters<Transport["send"]>[0];

class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  starts = 0;
  readonly sent: Message[] = [];
  closed = false;
  async start(): Promise<void> {
    this.starts += 1;
  }
  async send(message: Message): Promise<void> {
    this.sent.push(message);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  receive(message: Message): void {
    this.onmessage?.(message);
  }
}

const initialize: Message = { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
const toolsList: Message = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

describe("EarlyStartTransport (#11173)", () => {
  test("reads from the start and holds messages, in order, until a server connects", async () => {
    const inner = new FakeTransport();
    const early = new EarlyStartTransport(inner);
    await early.startEarly();
    inner.receive(initialize);
    inner.receive(toolsList);

    const delivered: Message[] = [];
    early.onmessage = (message) => {
      delivered.push(message);
    };
    expect(delivered).toEqual([]);

    await early.start();
    expect(delivered).toEqual([initialize, toolsList]);
    inner.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(delivered).toHaveLength(3);
    expect(inner.starts).toBe(1);

    await early.send({ jsonrpc: "2.0", id: 1, result: {} });
    expect(inner.sent).toHaveLength(1);
    await early.close();
    expect(inner.closed).toBe(true);
  });

  test("a close before the server connects is reported once it does", async () => {
    const inner = new FakeTransport();
    const early = new EarlyStartTransport(inner);
    await early.startEarly();
    inner.onclose?.();

    let closes = 0;
    early.onclose = () => {
      closes += 1;
    };
    await early.start();
    expect(closes).toBe(1);
  });

  test("start without startEarly starts the inner transport once", async () => {
    const inner = new FakeTransport();
    const early = new EarlyStartTransport(inner);
    await early.start();
    await early.startEarly();
    expect(inner.starts).toBe(1);
  });
});
