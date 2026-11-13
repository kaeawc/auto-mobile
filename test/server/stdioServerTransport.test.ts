import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { JSONRPCMessage } from "@modelcontextprotocol/server";
import { createStdioServerTransport } from "../../src/server/stdioServerTransport";

// Issue #4678: the v1-compatible stdio transport reads stdin only between start() and close().

const PING = { jsonrpc: "2.0", id: 1, method: "ping" } as const;

function harness(maxRequestBytes?: number) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const transport = createStdioServerTransport(stdin, stdout, { maxRequestBytes });
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

  // Issue #18330: the SDK closed the transport on a message over its 10 MB buffer.
  describe("request size limit", () => {
    const LIMIT = 128;
    const call = (id: number, bytes: number) => {
      const shell = JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { b: "" } });
      return shell.replace('"b":""', `"b":"${"A".repeat(bytes - shell.length)}"`);
    };

    test("a message at the limit is delivered", async () => {
      const { stdin, transport, messages } = harness(LIMIT);
      await transport.start();
      const line = call(1, LIMIT);
      stdin.write(`${line}\n`);
      await nextTurn();

      expect(messages).toEqual([JSON.parse(line)]);
      await transport.close();
    });

    test("a message over the limit gets a JSON-RPC error naming the limit and the session stays open", async () => {
      const { stdin, stdout, transport, messages } = harness(LIMIT);
      const written: string[] = [];
      stdout.on("data", (chunk: Buffer) => written.push(chunk.toString()));
      let closed = false;
      transport.onclose = () => {
        closed = true;
      };
      await transport.start();

      stdin.write(`${call(5, LIMIT + 1)}\n`);
      stdin.write(`${JSON.stringify(PING)}\n`);
      await nextTurn();

      expect(closed).toBe(false);
      expect(messages).toEqual([PING]);
      const response = JSON.parse(written.join(""));
      expect(response.id).toBe(5);
      expect(response.error.code).toBe(-32600);
      expect(response.error.data).toEqual({ limitBytes: LIMIT, requestBytes: LIMIT + 1 });
      expect(response.error.message).toContain(`limit of ${LIMIT} bytes`);
      expect(response.error.message).toContain("sourcePath");
      expect(response.error.message).toContain("HTTP");
      await transport.close();
    });

    test("an oversized message without an id is reported through onerror", async () => {
      const { stdin, transport, errors } = harness(LIMIT);
      await transport.start();
      stdin.write(
        `{"jsonrpc":"2.0","method":"notifications/x","params":{"b":"${"A".repeat(LIMIT)}"}}\n`,
      );
      await nextTurn();

      expect(errors.map((error) => error.message)).toEqual([
        expect.stringContaining(`limit of ${LIMIT} bytes`),
      ]);
      await transport.close();
    });

    test("no message is delivered after close()", async () => {
      const { stdin, transport, messages } = harness(LIMIT);
      await transport.start();
      await transport.close();
      stdin.write(`${JSON.stringify(PING)}\n`);
      await nextTurn();
      expect(messages).toEqual([]);
    });
  });
});
