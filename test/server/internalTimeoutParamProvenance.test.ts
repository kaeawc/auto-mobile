/**
 * Issue #6222 P1 review (codex fuQ8_ / coderabbit fuTtS): a direct MCP caller
 * on a non-daemon server (`createMcpServer({ daemonMode: false })`) must
 * never be able to forge its own transport deadline by supplying the
 * undocumented `__mcpRequestTimeoutMs` argument -- only a daemon-forwarded
 * call (`daemonMode: true`, the only topology that ever legitimately sets it,
 * see `withSocketSessionAutolockKey` in `src/daemon/socketServer.ts`) may
 * have it honored and reattached onto the handler's arguments.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse, getStructuredField } from "../../src/utils/toolUtils";
import {
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
  INTERNAL_TOOL_PARAM_NAMES,
} from "../../src/daemon/constants";

const TOOL = "__internal_timeout_provenance_probe_6222__";
const STRICT_TOOL = "__internal_strip_strict_probe_6917__";

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
      // regardless of schema shape. The complementary gap in
      // `stripInternalToolParams`'s early-return guard is covered by
      // STRICT_TOOL below (#6917 review, PRRT_kwDOP-GF5M6h40fK).
      z.object({}),
      async (args: unknown) => {
        const received = (args as Record<string, unknown>)[INTERNAL_MCP_REQUEST_TIMEOUT_PARAM];
        const receivedDeadline = (args as Record<string, unknown>)[
          INTERNAL_MCP_REQUEST_DEADLINE_PARAM
        ];
        return createStructuredToolResponse({
          success: true,
          receivedTimeoutMs: typeof received === "number" ? received : null,
          receivedDeadlineMs: typeof receivedDeadline === "number" ? receivedDeadline : null,
        });
      },
      {
        outputSchema: z.object({
          success: z.boolean(),
          receivedTimeoutMs: z.number().nullable(),
          receivedDeadlineMs: z.number().nullable(),
        }),
      },
    );

    // #6917 review (PRRT_kwDOP-GF5M6h40fK): a STRICT input schema, like the
    // ones #6712 tightened (`getNavigationGraphSchema` et al). Every internal
    // param must be stripped before this parse -- the daemon's
    // `ide/getNavigationGraph` route forwards `__mcpRequestTimeoutMs` as the
    // ONLY internal marker, so a strip guard that ignores the timeout/deadline
    // keys leaves it on the arguments and the parse fails with
    // "Unrecognized key" before the handler ever runs.
    ToolRegistry.register(
      STRICT_TOOL,
      "probe tool whose input schema rejects undeclared arguments",
      z.object({ appId: z.string().optional() }).strict(),
      async () => createStructuredToolResponse({ success: true }),
      { outputSchema: z.object({ success: z.boolean() }) },
    );
  });

  afterAll(() => {
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(TOOL);
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(STRICT_TOOL);
  });

  describe("daemonMode: false (direct, non-daemon server)", () => {
    // One shared fixture per describe block (not beforeEach): matches the
    // McpTestFixture convention used by ping.test.ts / index.progress.test.ts
    // / planExecutionLock.test.ts, so the server-setup/warmup cost is paid
    // once per block instead of being re-charged to every individual test's
    // reported duration under the 100ms unit-test budget.
    let fixture: McpTestFixture;

    beforeAll(async () => {
      fixture = new McpTestFixture({ daemonMode: false });
      await fixture.setup();
    });

    afterAll(async () => {
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

    test("a caller-supplied __mcpRequestDeadlineMs is IGNORED, never reattached", async () => {
      const { client } = fixture.getContext();
      const result = await client.callTool({
        name: TOOL,
        arguments: { [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: 1 },
      });

      expect(getStructuredField(result, "receivedDeadlineMs")).toBeNull();
    });
  });

  describe("daemonMode: true (daemon-forwarded loopback server)", () => {
    // See the daemonMode:false block above for why this is beforeAll/afterAll
    // rather than per-test beforeEach/afterEach.
    let fixture: McpTestFixture;

    beforeAll(async () => {
      fixture = new McpTestFixture({ daemonMode: true });
      await fixture.setup();
    });

    afterAll(async () => {
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

    test("a legitimate __mcpRequestDeadlineMs is honored and reattached", async () => {
      const { client } = fixture.getContext();
      const result = await client.callTool({
        name: TOOL,
        arguments: { [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: 98_765 },
      });

      expect(getStructuredField(result, "receivedDeadlineMs")).toBe(98_765);
    });

    // Each of these is forwarded alone by at least one daemon route --
    // `ide/getNavigationGraph` sends only `__mcpRequestTimeoutMs` -- so the
    // strip must not depend on a session/execution marker riding along.
    for (const internalParam of [
      INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
      INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
      INTERNAL_LIVE_DEADLINE_KEY_PARAM,
    ]) {
      test(`${internalParam} alone is stripped before a strict input schema parses`, async () => {
        const { client } = fixture.getContext();
        const result = await client.callTool({
          name: STRICT_TOOL,
          arguments: {
            [internalParam]:
              internalParam === INTERNAL_LIVE_DEADLINE_KEY_PARAM ? "live-key" : 12_345,
          },
        });

        expect(result.isError ?? false).toBe(false);
        expect(getStructuredField(result, "success")).toBe(true);
      });
    }

    test("every canonical internal param is stripped before a strict schema parses", async () => {
      const { client } = fixture.getContext();
      const args: Record<string, unknown> = { appId: "com.example" };
      for (const internalParam of INTERNAL_TOOL_PARAM_NAMES) {
        args[internalParam] = internalParam === INTERNAL_LIVE_DEADLINE_KEY_PARAM ? "live-key" : 1;
      }

      const result = await client.callTool({ name: STRICT_TOOL, arguments: args });

      expect(result.isError ?? false).toBe(false);
      expect(getStructuredField(result, "success")).toBe(true);
    });
  });
});
