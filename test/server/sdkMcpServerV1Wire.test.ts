import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  InMemoryTransport,
  type JSONRPCMessage,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { createMcpServer } from "../../src/server/index";
import { createSdkMcpServer, v1AbortSignal } from "../../src/server/sdkMcpServer";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";

/*
 * Server-side wire frames for the SDK v2 migration (issue #4678). Each test sends raw JSON-RPC
 * frames into our server and asserts the serialized response exactly as it leaves the server
 * transport, so no client-side error rendering (prefixing, re-coding) can hide a difference.
 * Expected values are the frames the v1 SDK server produced for the same requests.
 */

const BAD_RESULT_TOOL = "__v1_wire_bad_result__";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: "init",
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw-frame-test", version: "1" },
  },
} as const;

function zodIssue(path: string[], expected: string, received: string) {
  return {
    expected,
    code: "invalid_type",
    path,
    message: `Invalid input: expected ${expected}, received ${received}`,
  };
}

/** The raw client end of an InMemoryTransport pair: frames in, serialized frames out. */
class RawWire {
  private readonly frames: JSONRPCMessage[] = [];
  private readonly waiters = new Map<string | number, (frame: JSONRPCMessage) => void>();

  constructor(private readonly transport: InMemoryTransport) {
    transport.onmessage = (frame) => {
      this.frames.push(frame);
      const id = "id" in frame ? frame.id : undefined;
      if (id !== undefined && ("result" in frame || "error" in frame)) {
        this.waiters.get(id)?.(frame);
      }
    };
  }

  async request(frame: { id: string | number } & Record<string, unknown>): Promise<string> {
    const answered = new Promise<JSONRPCMessage>((resolve) => this.waiters.set(frame.id, resolve));
    await this.transport.send({ jsonrpc: "2.0", ...frame } as JSONRPCMessage);
    return JSON.stringify(await answered);
  }

  notify(frame: Record<string, unknown>): Promise<void> {
    return this.transport.send({ jsonrpc: "2.0", ...frame } as JSONRPCMessage);
  }
}

describe("direct server raw wire frames match the v1 SDK", () => {
  let restoreHermeticServer: () => void;
  let wire: RawWire;
  let close: () => Promise<void>;

  beforeAll(async () => {
    restoreHermeticServer = installHermeticServerFixture();
    ToolRegistry.register(
      BAD_RESULT_TOOL,
      "returns a result that is not a valid tools/call result",
      z.object({}),
      // A non-array `content` is what the SDK's tools/call result validation rejects.
      async () => JSON.parse('{"content":"not-an-array"}'),
    );
    const server = createMcpServer({});
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    wire = new RawWire(clientTransport);
    await clientTransport.start();
    close = () => server.close();
  });

  afterAll(async () => {
    await close?.();
    restoreHermeticServer?.();
  });

  test("initialize advertises the v1 capabilities, in v1 key order, plus the skills extension", async () => {
    const response = JSON.parse(await wire.request(INITIALIZE));
    await wire.notify({ method: "notifications/initialized" });

    expect(JSON.stringify(response.result.capabilities)).toBe(
      JSON.stringify({
        resources: { subscribe: true, listChanged: true },
        tools: { listChanged: true },
        prompts: {},
        extensions: { "io.modelcontextprotocol/skills": {} },
      }),
    );
  });

  test("tools/call without a name answers -32603 with the bare validation message", async () => {
    const frame = await wire.request({ id: 2, method: "tools/call", params: {} });

    expect(frame).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        error: {
          code: -32603,
          message: JSON.stringify([zodIssue(["params", "name"], "string", "undefined")], null, 2),
        },
      }),
    );
  });

  test("an invalid tool result answers -32602 with the MCP error prefix", async () => {
    const frame = await wire.request({
      id: 3,
      method: "tools/call",
      params: { name: BAD_RESULT_TOOL, arguments: {} },
    });

    expect(frame).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        error: {
          code: -32602,
          message:
            "MCP error -32602: Invalid tools/call result: " +
            JSON.stringify([zodIssue(["content"], "array", "string")], null, 2),
        },
      }),
    );
  });

  test("an unknown method answers -32601 Method not found", async () => {
    const frame = await wire.request({ id: 4, method: "no/such/method", params: {} });

    expect(frame).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        error: { code: -32601, message: "Method not found" },
      }),
    );
  });

  test("resources/read without a uri answers -32603 with the bare validation message", async () => {
    const frame = await wire.request({ id: 5, method: "resources/read", params: {} });

    expect(frame).toBe(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        error: {
          code: -32603,
          message: JSON.stringify([zodIssue(["params", "uri"], "string", "undefined")], null, 2),
        },
      }),
    );
  });
});

describe("request handlers see v1 abort reasons", () => {
  async function connectedHangingServer() {
    const server = createSdkMcpServer({ name: "abort-test", version: "1" }, { resources: {} });
    const started = Promise.withResolvers<AbortSignal>();
    server.server.setRequestHandler("resources/list", (_request, ctx) => {
      started.resolve(ctx.mcpReq.signal);
      return new Promise(() => {});
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const wire = new RawWire(clientTransport);
    await clientTransport.start();
    await wire.request(INITIALIZE);
    await wire.notify({ method: "notifications/initialized" });
    void wire.request({ id: "hang", method: "resources/list", params: {} });
    return { server, wire, signal: await started.promise };
  }

  test("transport close aborts the handler with an AbortError, as v1 did", async () => {
    const { server, signal } = await connectedHangingServer();

    await server.close();

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect(signal.reason.name).toBe("AbortError");
    expect(() => signal.throwIfAborted()).toThrow(expect.objectContaining({ name: "AbortError" }));
  });

  test("a notifications/cancelled reason reaches the handler unchanged", async () => {
    const { server, wire, signal } = await connectedHangingServer();

    await wire.notify({
      method: "notifications/cancelled",
      params: { requestId: "hang", reason: "client gave up" },
    });

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("client gave up");
    await server.close();
  });

  test("v1AbortSignal maps only a connection-closed reason, also when already aborted", () => {
    const reason = new Error("custom");
    const closed = v1AbortSignal(
      AbortSignal.abort(new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed")),
    );

    expect(v1AbortSignal(AbortSignal.abort(reason)).reason).toBe(reason);
    expect(closed.reason).toBeInstanceOf(DOMException);
    expect(closed.reason.name).toBe("AbortError");
  });
});
