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
 * The target app is not installed, so there is nothing to act on. A subclass so callers can
 * tell "nothing to clean" from a real failure without matching message text.
 */
export class AppNotInstalledError extends ActionableError {}

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

/** Build a consistent client-facing error for an action unavailable on a platform. */
export function unsupportedPlatformError(platform: string, action: string): ActionableError {
  return new ActionableError(
    `${action} is not supported on platform '${platform}'. Supported platforms: android, ios.`,
  );
}
