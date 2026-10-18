import type { McpOverloadFailure } from "./McpTimeoutError";

/** A live daemon rejected queued work before its caller's deadline expired. */
export class McpOverloadError extends Error {
  constructor(
    message: string,
    readonly failure: McpOverloadFailure,
  ) {
    super(message);
    this.name = "McpOverloadError";
  }
}
