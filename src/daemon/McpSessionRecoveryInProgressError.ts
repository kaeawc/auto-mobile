import { ActionableError } from "../models";

export class McpSessionRecoveryInProgressError extends ActionableError {
  constructor(mcpSessionId: string) {
    super(
      `MCP session '${mcpSessionId}' is recovering a device and cannot remap until recovery finishes.`,
    );
  }
}
