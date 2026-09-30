import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  isDeviceControlTransportRequest,
  isReplaySafeAfterResponseClosure,
  isLoopbackTransportFailure,
  loopbackMcpFetch,
  LoopbackMcpConnectionError,
} from "../../src/daemon/deviceControlTransportFailure";
import { ToolRegistry, ToolRegistryClass } from "../../src/server/toolRegistry";

describe("loopback MCP transport failure classification", () => {
  test("uses registered recovery capability and clears it with the registry", () => {
    const handler = async () => ({ content: [] });
    ToolRegistry.register("safeProbe", "read-only probe", {}, handler, {
      transportRecovery: "replay",
    });
    ToolRegistry.register("unsafeProbe", "changes state", {}, handler);
    ToolRegistry.registerDeviceAware("testDeviceAction", "changes device state", {}, handler);
    const safeRequest = { method: "tools/call", params: { name: "safeProbe" } } as const;
    const unsafeRequest = { method: "tools/call", params: { name: "unsafeProbe" } } as const;
    const deviceRequest = { method: "tools/call", params: { name: "testDeviceAction" } } as const;
    try {
      expect(isDeviceControlTransportRequest(safeRequest)).toBe(true);
      expect(isReplaySafeAfterResponseClosure(safeRequest)).toBe(true);
      expect(isDeviceControlTransportRequest(unsafeRequest)).toBe(false);
      expect(isReplaySafeAfterResponseClosure(unsafeRequest)).toBe(false);
      expect(isDeviceControlTransportRequest(deviceRequest)).toBe(true);
      expect(isReplaySafeAfterResponseClosure(deviceRequest)).toBe(false);
    } finally {
      ToolRegistry.clearTools();
    }
    expect(isDeviceControlTransportRequest(safeRequest)).toBe(false);
  });

  test("clearing another registry preserves the singleton's observe replay permission", () => {
    const handler = async () => ({ content: [] });
    const otherRegistry = new ToolRegistryClass();
    ToolRegistry.registerDeviceAware("observe", "Read device state", {}, handler, {
      transportRecovery: "replay",
    });
    try {
      otherRegistry.registerDeviceAware("observe", "Other device state", {}, handler);
      otherRegistry.clearTools();
      expect(ToolRegistry.getToolTransportRecovery("observe")).toBe("replay");
      expect(
        isReplaySafeAfterResponseClosure({ method: "tools/call", params: { name: "observe" } }),
      ).toBe(true);
    } finally {
      ToolRegistry.clearTools();
    }
  });

  test("real SDK transport preserves a failed loopback fetch", async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP port");
    }
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
      { fetch: loopbackMcpFetch },
    );
    await transport.start();
    try {
      const failure = await transport
        .send({ jsonrpc: "2.0", id: 1, method: "ping" })
        .catch((error: unknown) => error);
      expect(isLoopbackTransportFailure(failure)).toBe(true);
    } finally {
      await transport.close();
    }
  });

  test("tags a rejected fetch regardless of its message", async () => {
    const cause = new Error("new runtime wording");
    const failure = await loopbackMcpFetch("http://localhost:1234/mcp", undefined, async () => {
      throw cause;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(LoopbackMcpConnectionError);
    expect((failure as LoopbackMcpConnectionError).cause).toBe(cause);
    expect(isLoopbackTransportFailure(failure)).toBe(true);
  });

  test("does not classify an MCP error even if its message mentions a closure", () => {
    expect(
      isLoopbackTransportFailure(
        new McpError(ErrorCode.InternalError, "The socket connection was closed unexpectedly"),
      ),
    ).toBe(false);
  });

  test("leaves aborted fetches untagged", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new Error("cancelled");
    const failure = await loopbackMcpFetch(
      "http://localhost:1234/mcp",
      { signal: controller.signal },
      async () => {
        throw abortError;
      },
    ).catch((error: unknown) => error);

    expect(failure).toBe(abortError);
    expect(isLoopbackTransportFailure(failure)).toBe(false);
  });
});
