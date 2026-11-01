/**
 * A stdio MCP server for the real-client elicitation conformance run (#15591). It is built with
 * AutoMobile's own dispatcher, so the question it asks is the one the production server asks: a
 * tool that always answers the typed `ambiguous_device_target` refusal. Each recorded outcome is
 * appended to STUB_LOG as one JSON line.
 */
import { appendFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createSdkMcpServer } from "../../../src/server/sdkMcpServer";
import {
  installToolCallDispatcher,
  type McpToolCallExtra,
} from "../../../src/server/toolCallDispatch";
import { registerElicitationRecorder } from "../../../src/server/elicitationOutcome";
import { MODERN_CACHE_HINTS } from "../../../src/server/modernCacheHints";

const era = process.env.STUB_ERA === "modern" ? "modern" : "legacy";
const log = process.env.STUB_LOG ?? "";

registerElicitationRecorder({
  record: (record) => appendFileSync(log, `${JSON.stringify({ kind: "record", ...record })}\n`),
});

const refusal = {
  isError: true,
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({
        code: "ambiguous_device_target",
        candidates: [
          { deviceId: "emulator-5554", platform: "android" },
          { deviceId: "emulator-5556", platform: "android" },
        ],
      }),
    },
  ],
};

const server = createSdkMcpServer(
  { name: "stub", version: "0.0.0" },
  { tools: { listChanged: true } },
  { cacheHints: era === "modern" ? MODERN_CACHE_HINTS : undefined },
);

server.server.setRequestHandler("tools/list", async () => ({
  tools: [
    {
      name: "ask",
      description: "Ask which device to use. Always call this tool.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ],
}));

installToolCallDispatcher(
  server,
  {
    progressFailureMessage: "progress failed",
    execute: async (call) => {
      const extra: McpToolCallExtra = call.extra;
      appendFileSync(
        log,
        `${JSON.stringify({
          kind: "call",
          era,
          deviceId: call.args.deviceId ?? null,
          legacyCapabilities: server.server.getClientCapabilities() ?? null,
          envelope: extra.envelope ?? null,
        })}\n`,
      );
      return call.args.deviceId === undefined
        ? refusal
        : { content: [{ type: "text" as const, text: `ran on ${String(call.args.deviceId)}` }] };
    },
  },
  era === "modern"
    ? { era: "modern" }
    : { ambiguousDeviceElicitation: { timeoutMs: Number(process.env.STUB_TIMEOUT_MS ?? 20_000) } },
);

await server.connect(new StdioServerTransport());
