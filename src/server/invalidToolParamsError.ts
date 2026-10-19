import { ErrorCode, McpError } from "../daemon/mcpError";

/** Keep the wire message unprefixed; the SDK client adds its own MCP error prefix. */
export class InvalidToolParamsError extends McpError {
  constructor(message: string) {
    super(ErrorCode.InvalidParams, message);
    this.message = message;
  }
}
