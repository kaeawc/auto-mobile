import { createServer, type Server } from "node:http";

/**
 * A loopback stand-in for the Anthropic Messages API that makes a real Claude Code call one MCP
 * tool and then finish. The first streamed turn answers with a `tool_use` for the tool whose name
 * ends in `toolSuffix`; once the request carries a `tool_result` it answers with plain text.
 */
export interface FakeAnthropicApi {
  readonly url: string;
  /** The text of the tool result Claude Code sent back, once it has. */
  toolResultText(): string | undefined;
  close(): Promise<void>;
}

function frame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

function streamedTurn(toolName: string | undefined): string {
  const message = { id: "m1", type: "message", role: "assistant", content: [], model: "fake" };
  const usage = { output_tokens: 5 };
  const body =
    toolName === undefined
      ? [
          frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
          frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } }),
          frame("content_block_stop", { index: 0 }),
          frame("message_delta", { delta: { stop_reason: "end_turn" }, usage }),
        ]
      : [
          frame("content_block_start", {
            index: 0,
            content_block: { type: "tool_use", id: "toolu_1", name: toolName, input: {} },
          }),
          frame("content_block_delta", {
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          }),
          frame("content_block_stop", { index: 0 }),
          frame("message_delta", { delta: { stop_reason: "tool_use" }, usage }),
        ];
  return [frame("message_start", { message }), ...body, frame("message_stop", {})].join("");
}

function toolNames(request: unknown): string[] {
  const tools = (request as { tools?: Array<{ name?: string }> }).tools ?? [];
  return tools.flatMap((tool) => (tool.name === undefined ? [] : [tool.name]));
}

function toolResultOf(request: unknown): string | undefined {
  const messages = (request as { messages?: Array<{ content?: unknown }> }).messages ?? [];
  for (const message of messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === "tool_result") {
        return JSON.stringify(block.content);
      }
    }
  }
  return undefined;
}

export async function startFakeAnthropicApi(toolSuffix: string): Promise<FakeAnthropicApi> {
  let seenResult: string | undefined;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let request: unknown = {};
      try {
        request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        // Non-JSON probes (telemetry, health) just get an empty object back.
      }
      if (!req.url?.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      seenResult ??= toolResultOf(request);
      const tool = toolNames(request).find((name) => name.endsWith(toolSuffix));
      const streamed = (request as { stream?: boolean }).stream === true;
      if (!streamed) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: "m1",
            type: "message",
            role: "assistant",
            model: "fake",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(streamedTurn(seenResult === undefined ? tool : undefined));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    toolResultText: () => seenResult,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
