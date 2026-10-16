/**
 * Build Claude Code stream-json transcripts for agent benchmark tests. Event
 * shapes mirror a real `claude -p --output-format stream-json --verbose` run
 * (Claude Code 2.1.x), trimmed to the fields the auditor reads plus a few it
 * must ignore.
 */

type Event = Record<string, unknown>;

export class TranscriptBuilder {
  private readonly events: Event[] = [];
  private nextId = 1;

  init(options: { model?: string; mcpStatus?: string | null } = {}): this {
    this.events.push({ type: "active_goal", value: null });
    this.events.push({
      type: "system",
      subtype: "init",
      model: options.model ?? "claude-test-model",
      claude_code_version: "2.1.301",
      mcp_servers:
        options.mcpStatus === null
          ? []
          : [{ name: "auto-mobile", status: options.mcpStatus ?? "connected", source: "dynamic" }],
    });
    this.events.push({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    return this;
  }

  /** Append a tool_use and (unless `noResult`) its tool_result; returns the builder. */
  tool(
    name: string,
    result: string | Array<{ type: string; text?: string }>,
    options: { isError?: boolean; parentToolUseId?: string; noResult?: boolean } = {},
  ): this {
    const id = `toolu_${this.nextId++}`;
    this.events.push({
      type: "assistant",
      message: {
        model: "claude-test-model",
        role: "assistant",
        content: [{ type: "tool_use", id, name, input: {}, caller: { type: "direct" } }],
      },
      parent_tool_use_id: options.parentToolUseId ?? null,
    });
    if (options.noResult) {
      return this;
    }
    const block: Event = { type: "tool_result", tool_use_id: id, content: result };
    if (options.isError) {
      block.is_error = true;
    }
    this.events.push({
      type: "user",
      message: { role: "user", content: [block] },
      parent_tool_use_id: options.parentToolUseId ?? null,
    });
    return this;
  }

  mcp(tool: string, result = "ok", options: { isError?: boolean; noResult?: boolean } = {}): this {
    return this.tool(`mcp__auto-mobile__${tool}`, [{ type: "text", text: result }], options);
  }

  text(text: string): this {
    this.events.push({
      type: "assistant",
      message: { model: "claude-test-model", role: "assistant", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    });
    this.events.push({
      type: "system",
      subtype: "post_turn_summary",
      status_category: "completed",
    });
    return this;
  }

  result(
    options: {
      subtype?: string;
      isError?: boolean;
      finalText?: string;
      costUsd?: number;
      numTurns?: number;
      permissionDenials?: unknown[];
    } = {},
  ): this {
    this.events.push({
      type: "result",
      subtype: options.subtype ?? "success",
      is_error: options.isError ?? false,
      result: options.finalText ?? "done",
      num_turns: options.numTurns ?? 3,
      total_cost_usd: options.costUsd ?? 0.0123,
      duration_ms: 4000,
      terminal_reason: "completed",
      permission_denials: options.permissionDenials ?? [],
      usage: {
        input_tokens: 4,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1000,
        output_tokens: 50,
      },
    });
    return this;
  }

  build(): string {
    return `${this.events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  }
}
