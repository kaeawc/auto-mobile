import { ActionableError } from "../models/ActionableError";
import { DAEMON_UNKNOWN_TOOL_CODE } from "./types";

/**
 * A tool this server does not register at all. Same message as ever; `data` lets the daemon
 * proxy classify it by code instead of parsing "Unknown tool:" prose.
 */
export class UnknownToolError extends ActionableError {
  readonly data: { code: typeof DAEMON_UNKNOWN_TOOL_CODE; toolName: string };

  constructor(toolName: string, hint?: string) {
    super(`Unknown tool: ${toolName}${hint ? `. ${hint}` : ""}`);
    this.name = "UnknownToolError";
    this.data = { code: DAEMON_UNKNOWN_TOOL_CODE, toolName };
  }
}
