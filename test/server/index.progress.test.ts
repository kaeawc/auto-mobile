import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import type { ProgressCallback } from "../../src/server/toolRegistry";

/**
 * Proves the fix for issue #6118 at the real MCP CallTool boundary
 * (`src/server/index.ts`'s `CallToolRequestSchema` handler, not the dead
 * `ToolRegistry.registerWithServer` path): progress notifications must echo
 * the client-supplied `_meta.progressToken`, and none must be sent when the
 * client didn't ask for progress at all.
 */
describe("CallTool progress notifications echo the client's token (issue #6118)", () => {
  let fixture: McpTestFixture;
  const TOOL = "__progress_probe_6118__";

  beforeAll(async () => {
    ToolRegistry.register(
      TOOL,
      "probe tool that reports two progress ticks",
      z.object({}).passthrough(),
      async (_args: unknown, progress?: ProgressCallback) => {
        await progress?.(1, 2, "tick one");
        await progress?.(2, 2, "tick two");
        return createStructuredToolResponse({ success: true });
      },
      { supportsProgress: true },
    );
    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(TOOL);
  });

  test("client onprogress receives ticks carrying the client's own token", async () => {
    const { client } = fixture.getContext();
    const received: Array<{ progressToken?: unknown; progress: number; total?: number }> = [];
    const errors: string[] = [];
    client.onerror = (error) => {
      errors.push(String(error));
    };

    await client.callTool({ name: TOOL, arguments: {} }, undefined, {
      onprogress: (notification) => {
        received.push(notification as unknown as { progress: number; total?: number });
      },
    });

    expect(received).toHaveLength(2);
    expect(received[0].progress).toBe(1);
    expect(received[1].progress).toBe(2);
    // The SDK client strips progressToken off before handing the notification
    // to onprogress (it uses it internally to route the callback), so the
    // absence of an "unknown token" error IS the proof the server echoed the
    // token the client registered rather than fabricating its own.
    expect(errors).toHaveLength(0);
  });

  test("no progress notification is sent when the client did not request one", async () => {
    const { client } = fixture.getContext();
    const errors: string[] = [];
    client.onerror = (error) => {
      errors.push(String(error));
    };

    // No `onprogress` option: the SDK client sends no `_meta.progressToken`.
    const result = await client.callTool({ name: TOOL, arguments: {} });

    expect(result).toBeDefined();
    // No fabricated token means the client never gets an "unknown token"
    // protocol error even though the tool called progress() twice server-side.
    expect(errors).toHaveLength(0);
  });
});
