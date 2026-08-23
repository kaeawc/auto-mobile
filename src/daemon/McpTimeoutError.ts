export class McpTimeoutError extends Error {
  readonly toolName: string;
  readonly timeoutMs: number;
  readonly origin: string;

  constructor(opts: { toolName: string; timeoutMs: number; origin: string; detail?: string }) {
    const detail = opts.detail ? ` (${opts.detail})` : "";
    super(`MCP timeout: ${opts.toolName} exceeded ${opts.timeoutMs}ms at ${opts.origin}${detail}`);
    this.name = "McpTimeoutError";
    this.toolName = opts.toolName;
    this.timeoutMs = opts.timeoutMs;
    this.origin = opts.origin;
  }
}
