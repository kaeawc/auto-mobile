import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import { createStdioServerTransport } from "../../src/server/stdioServerTransport";

// Issue #4678: the v1-compatible stdio transport reads stdin only between start() and close().

const PING = { jsonrpc: "2.0", id: 1, method: "ping" } as const;

function harness() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = createStdioServerTransport(stdin, stdout);
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => errors.push(error);
  return { stdin, stdout, transport, messages, errors };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("createStdioServerTransport", () => {
  test("a stdin error before start() is not forwarded and does not throw", async () => {
    const { stdin, transport, errors } = harness();
    stdin.on("error", () => {}); // The lifecycle handlers own stdin's own error listener.

    expect(() => stdin.emit("error", new Error("early"))).not.toThrow();
    await transport.start();

    expect(errors).toEqual([]);
    await transport.close();
  });

  test("a stdin error while started reaches onerror and keeps reading", async () => {
    const { stdin, transport, messages, errors } = harness();
    stdin.on("error", () => {});
    await transport.start();

    stdin.emit("error", new Error("mid"));
    stdin.write(`${JSON.stringify(PING)}\n`);
    await nextTurn();

    expect(errors.map((error) => error.message)).toEqual(["mid"]);
    expect(messages).toEqual([PING]);
    await transport.close();
  });

  test("a stdin error after close() is not forwarded and does not throw", async () => {
    const { stdin, transport, errors } = harness();
    stdin.on("error", () => {});
    await transport.start();
    await transport.close();

    expect(() => stdin.emit("error", new Error("late"))).not.toThrow();
    expect(errors).toEqual([]);
  });

  test("a request and EOF piped before start() are delivered and can be answered", async () => {
    const { stdin, stdout, transport, messages } = harness();
    const written: string[] = [];
    stdout.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    stdin.end(`${JSON.stringify(PING)}\n`);
    await nextTurn();

    await transport.start();
    await nextTurn();
    await transport.send({ jsonrpc: "2.0", id: 1, result: {} });

    expect(messages).toEqual([PING]);
    expect(written.join("")).toBe(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
    await transport.close();
  });
});
