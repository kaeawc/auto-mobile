import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";

/**
 * Tests for ToolRegistry.registerWithServer to verify that progress callbacks
 * and abort signals are correctly passed through to tool handlers.
 *
 * Uses a FakeMcpServer to capture registered tool handlers and verify behavior
 * without depending on a real MCP transport connection.
 */

// Fake McpServer that captures registered tools and their handlers
interface RegisteredMcpTool {
  name: string;
  config: { description?: string; inputSchema?: any; outputSchema?: any };
  handler: (args: any, extra: any) => Promise<any>;
}

class FakeMcpServer {
  registeredTools: RegisteredMcpTool[] = [];
  // Underlying Protocol stand-in — registerWithServer chains `onclose` here.
  server: { onclose?: () => void } = {};

  registerTool(name: string, config: any, handler: any): void {
    this.registeredTools.push({ name, config, handler });
  }

  getRegisteredHandler(name: string): ((args: any, extra: any) => Promise<any>) | undefined {
    return this.registeredTools.find((t) => t.name === name)?.handler;
  }
}

// Minimal ToolRegistry replica that tests the registerWithServer logic in isolation.
// We import the real ToolRegistryClass behavior but isolate the test from the singleton.
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { ProgressCallback } from "../../src/server/toolRegistry";

describe("ToolRegistry.registerWithServer", () => {
  let fakeMcpServer: FakeMcpServer;

  beforeEach(() => {
    ToolRegistry.clearTools();
    fakeMcpServer = new FakeMcpServer();
  });

  test("passes progress callback to handler when tool supportsProgress", async () => {
    let receivedProgress: ProgressCallback | undefined;
    let receivedSignal: AbortSignal | undefined;

    ToolRegistry.register(
      "progressTool",
      "A tool that supports progress",
      z.object({ input: z.string() }),
      async (args: any, progress?: ProgressCallback, signal?: AbortSignal) => {
        receivedProgress = progress;
        receivedSignal = signal;
        return { content: [{ type: "text", text: "done" }] };
      },
      { supportsProgress: true },
    );

    ToolRegistry.registerWithServer(fakeMcpServer as any);

    const handler = fakeMcpServer.getRegisteredHandler("progressTool");
    expect(handler).toBeDefined();

    const abortController = new AbortController();
    const fakeExtra = {
      signal: abortController.signal,
      _meta: { progressToken: "test-token-123" },
      sendNotification: async () => {},
      requestId: "req-1",
    };

    await handler!({ input: "hello" }, fakeExtra);

    expect(receivedProgress).toBeDefined();
    expect(typeof receivedProgress).toBe("function");
    expect(receivedSignal).toBe(abortController.signal);
  });

  test("progress callback sends notification via extra.sendNotification", async () => {
    let capturedProgress: ProgressCallback | undefined;
    const sentNotifications: any[] = [];

    ToolRegistry.register(
      "notifyTool",
      "A tool that sends progress",
      z.object({}),
      async (_args: any, progress?: ProgressCallback) => {
        capturedProgress = progress;
        return { content: [{ type: "text", text: "ok" }] };
      },
      { supportsProgress: true },
    );

    ToolRegistry.registerWithServer(fakeMcpServer as any);

    const handler = fakeMcpServer.getRegisteredHandler("notifyTool");
    const fakeExtra = {
      signal: new AbortController().signal,
      _meta: { progressToken: "my-token" },
      sendNotification: async (notification: any) => {
        sentNotifications.push(notification);
      },
      requestId: "req-2",
    };

    await handler!({}, fakeExtra);

    // Now invoke the progress callback that was passed to the handler
    expect(capturedProgress).toBeDefined();
    await capturedProgress!(50, 100, "halfway there");

    expect(sentNotifications).toHaveLength(1);
    expect(sentNotifications[0]).toEqual({
      method: "notifications/progress",
      params: {
        progressToken: "my-token",
        progress: 50,
        total: 100,
        message: "halfway there",
      },
    });
  });

  test("does not fabricate a token or pass a progress callback when _meta.progressToken is absent", async () => {
    let capturedProgress: ProgressCallback | undefined = undefined;
    const sentNotifications: any[] = [];

    ToolRegistry.register(
      "noTokenTool",
      "Tool without client-provided progress token",
      z.object({}),
      async (_args: any, progress?: ProgressCallback) => {
        capturedProgress = progress;
        return { content: [{ type: "text", text: "ok" }] };
      },
      { supportsProgress: true },
    );

    ToolRegistry.registerWithServer(fakeMcpServer as any);

    const handler = fakeMcpServer.getRegisteredHandler("noTokenTool");
    const fakeExtra = {
      signal: new AbortController().signal,
      _meta: {},
      sendNotification: async (notification: any) => {
        sentNotifications.push(notification);
      },
      requestId: "req-3",
    };

    await handler!({}, fakeExtra);

    // No client-supplied token: the handler must not fabricate one (#6118),
    // so the tool never receives a progress callback to invoke.
    expect(capturedProgress).toBeUndefined();
    expect(sentNotifications).toHaveLength(0);
  });

  test("does not pass progress callback for tools without supportsProgress", async () => {
    let receivedProgress: ProgressCallback | undefined = undefined;
    let receivedSignal: AbortSignal | undefined = undefined;

    ToolRegistry.register(
      "simpleTool",
      "A simple tool without progress",
      z.object({ value: z.number() }),
      async (args: any, progress?: ProgressCallback, signal?: AbortSignal) => {
        receivedProgress = progress;
        receivedSignal = signal;
        return { content: [{ type: "text", text: String(args.value) }] };
      },
    );

    ToolRegistry.registerWithServer(fakeMcpServer as any);

    const handler = fakeMcpServer.getRegisteredHandler("simpleTool");
    expect(handler).toBeDefined();

    const abortController = new AbortController();
    const fakeExtra = {
      signal: abortController.signal,
      _meta: {},
      sendNotification: async () => {},
      requestId: "req-4",
    };

    await handler!({ value: 42 }, fakeExtra);

    expect(receivedProgress).toBeUndefined();
    expect(receivedSignal).toBe(abortController.signal);
  });

  test("keeps output schemas internal instead of advertising them through MCP registration", () => {
    const outputSchema = z.object({ ok: z.boolean() });

    ToolRegistry.register(
      "schemaTool",
      "Tool with a structured result contract",
      z.object({}),
      async () => ({ content: [{ type: "text", text: "ok" }] }),
      { outputSchema: outputSchema },
    );

    ToolRegistry.registerWithServer(fakeMcpServer as any);

    const registeredTool = fakeMcpServer.registeredTools.find((tool) => tool.name === "schemaTool");
    expect(registeredTool).toBeDefined();
    expect(registeredTool!.config.outputSchema).toBeUndefined();
    expect(ToolRegistry.getTool("schemaTool")?.outputSchema).toBe(outputSchema);
  });

  test("progress callback does not throw when sendNotification fails", async () => {
    let capturedProgress: ProgressCallback | undefined;

    ToolRegistry.register(
      "failNotifyTool",
      "Tool where notification sending fails",
      z.object({}),
      async (_args: any, progress?: ProgressCallback) => {
        capturedProgress = progress;
        return { content: [{ type: "text", text: "ok" }] };
      },
      { supportsProgress: true },
    );

    ToolRegistry.registerWithServer(fakeMcpServer as any);

    const handler = fakeMcpServer.getRegisteredHandler("failNotifyTool");
    const fakeExtra = {
      signal: new AbortController().signal,
      _meta: { progressToken: "err-token" },
      sendNotification: async () => {
        throw new Error("Transport disconnected");
      },
      requestId: "req-5",
    };

    await handler!({}, fakeExtra);

    // Calling progress should not throw even when sendNotification fails
    expect(capturedProgress).toBeDefined();
    await expect(capturedProgress!(75, 100, "almost done")).resolves.toBeUndefined();
  });
});
