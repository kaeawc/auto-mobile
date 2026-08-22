import { errorMessage } from "../utils/describeUnknownError";
/**
 If thrown, the MCP server will catch it and send the message to the client.
 */
export class ActionableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Wrap an unknown caught error in an ActionableError with actionable context.
 *
 * Use at system/MCP boundaries and feature actions where the failure should
 * surface to the client (see the error-handling convention in CLAUDE.md).
 * Already-actionable errors are returned unchanged so context isn't doubled up.
 */
export function toActionableError(error: unknown, context: string): ActionableError {
  if (error instanceof ActionableError) {
    return error;
  }
  const message = errorMessage(error);
  return new ActionableError(`${context}: ${message}`, { cause: error });
}
