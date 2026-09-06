/**
 * Issue #6222 P1 review (codex fuQ8_ / coderabbit fuTtS): a direct MCP caller
 * on a non-daemon server (`createMcpServer({ daemonMode: false })`) must
 * never be able to forge its own transport deadline by supplying the
 * undocumented `__mcpRequestTimeoutMs` argument -- only a daemon-forwarded
 * call (`daemonMode: true`, the only topology that ever legitimately sets it,
 * see `withSocketSessionAutolockKey` in `src/daemon/socketServer.ts`) may
 * have it honored and reattached onto the handler's arguments.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse, getStructuredField } from "../../src/utils/toolUtils";
import { INTERNAL_MCP_REQUEST_TIMEOUT_PARAM } from "../../src/daemon/constants";

const TOOL = "__internal_timeout_provenance_probe_6222__";

describe("internal `__mcpRequestTimeoutMs` provenance (issue #6222 P1 review)", () => {
  beforeAll(() => {
    ToolRegistry.register(
      TOOL,
      "probe tool that reports back whatever internal timeout param it received",
      // Deliberately NOT `.passthrough()` -- matches `setUIStateSchema`'s
      // real shape (a plain z.object), which silently strips any unknown key
      // (including a caller-forged `__mcpRequestTimeoutMs`) during
      // `tool.schema.parse()`. The reattachment this test targets happens
      // AFTER that parse, straight onto `handlerParams`, so it is exercised
      // regardless of schema shape -- passthrough would conflate that with
      // an unrelated pre-existing gap in `stripInternalToolParams`'s guard.
      z.object({}),
      async (args: unknown) => {
        const received = (args as Record<string, unknown>)[INTERNAL_MCP_REQUEST_TIMEOUT_PARAM];
        return createStructuredToolResponse({
          success: true,
          receivedTimeoutMs: typeof received === "number" ? received : null,
        });
      },
      {
        outputSchema: z.object({
          success: z.boolean(),
          receivedTimeoutMs: z.number().nullable(),
        }),
      },
    );
  });

  afterAll(() => {
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(TOOL);
  });

  describe("daemonMode: false (direct, non-daemon server)", () => {
    let fixture: McpTestFixture;

    beforeAll(async () => {
      fixture = new McpTestFixture({ daemonMode: false });
      await fixture.setup();
    });

    afterEach(async () => {
      await fixture.teardown();
    });

    test("a caller-supplied __mcpRequestTimeoutMs is IGNORED, never reattached", async () => {
      const { client } = fixture.getContext();
      const result = await client.callTool({
        name: TOOL,
        arguments: { [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: 1 },
      });

      expect(getStructuredField(result, "receivedTimeoutMs")).toBeNull();
    });
  });

  describe("daemonMode: true (daemon-forwarded loopback server)", () => {
    let fixture: McpTestFixture;

    beforeAll(async () => {
      fixture = new McpTestFixture({ daemonMode: true });
      await fixture.setup();
    });

    afterEach(async () => {
      await fixture.teardown();
    });

    test("a legitimate __mcpRequestTimeoutMs is honored and reattached", async () => {
      const { client } = fixture.getContext();
      const result = await client.callTool({
        name: TOOL,
        arguments: { [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: 12_345 },
      });

      expect(getStructuredField(result, "receivedTimeoutMs")).toBe(12_345);
    });
  });
});
