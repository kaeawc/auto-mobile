/**
 * A local stand-in for the Anthropic Messages API: the first turn asks to call the stub tool, the
 * next one ends. No network and no real key are involved.
 */
export interface FakeAnthropicApi {
  readonly url: string;
  stop(): void;
}

type Block =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string };

function events(block: Block, stop: string): string {
  const content =
    block.kind === "text"
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: block.text },
          },
        ]
      : [
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "toolu_conformance",
              name: block.name,
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
          },
        ];
  return [
    {
      type: "message_start",
      message: {
        id: "msg_conformance",
        type: "message",
        role: "assistant",
        model: "claude-fake",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    ...content,
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

interface MessagesRequest {
  readonly stream?: boolean;
  readonly tools?: readonly { readonly name: string }[];
  readonly messages?: readonly unknown[];
}

export function startFakeAnthropicApi(toolName: string): FakeAnthropicApi {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith("/messages")) {
        return Response.json({});
      }
      const body = (await request.json().catch(() => ({}))) as MessagesRequest;
      const answered = JSON.stringify(body.messages ?? []).includes("tool_result");
      const offersTool = body.tools?.some((tool) => tool.name === toolName) === true;
      const block: Block =
        offersTool && !answered ? { kind: "tool", name: toolName } : { kind: "text", text: "done" };
      const stop = block.kind === "tool" ? "tool_use" : "end_turn";
      if (body.stream === true) {
        return new Response(events(block, stop), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        id: "msg_conformance",
        type: "message",
        role: "assistant",
        model: "claude-fake",
        content: [
          block.kind === "text"
            ? { type: "text", text: block.text }
            : { type: "tool_use", id: "toolu_conformance", name: block.name, input: {} },
        ],
        stop_reason: stop,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}
