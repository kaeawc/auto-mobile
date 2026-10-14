import * as sdk from "@modelcontextprotocol/sdk/types.js";

// The repo's ambient SDK declaration omits this runtime export.
const { ErrorCode } = sdk as typeof sdk & { ErrorCode: { InvalidParams: number } };

/** Keep the wire message unprefixed; the SDK client adds its own MCP error prefix. */
export class InvalidToolParamsError extends sdk.McpError {
  constructor(message: string) {
    super(ErrorCode.InvalidParams, message);
    this.message = message;
  }
}
