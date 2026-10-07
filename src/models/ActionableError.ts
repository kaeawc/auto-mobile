import type { ResolverSelector } from "../server/elementSelectorSchemas";
import { errorMessage } from "../utils/describeUnknownError";
// Structural match for ElementResolution.containerFailure from dependency PR #10292.
export interface ContainerFailure {
  level: number;
  reason: "not-found" | "ambiguous";
  selector: ResolverSelector;
}

/** If thrown, the MCP server will catch it and send the message to the client. */
export class ActionableError extends Error {
  declare readonly containerFailure?: ContainerFailure;

  constructor(message: string, options?: ErrorOptions & { containerFailure?: ContainerFailure }) {
    super(message, options);
    const containerFailure =
      options?.containerFailure ??
      (options?.cause instanceof ActionableError ? options.cause.containerFailure : undefined);
    if (containerFailure) {
      this.containerFailure = containerFailure;
    }
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

/** Build a consistent client-facing error for an action unavailable on a platform. */
export function unsupportedPlatformError(platform: string, action: string): ActionableError {
  return new ActionableError(
    `${action} is not supported on platform '${platform}'. Supported platforms: android, ios.`,
  );
}
