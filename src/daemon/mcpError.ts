import { ProtocolError, SdkError, SdkErrorCode } from "@modelcontextprotocol/server";

/**
 * JSON-RPC error codes this repo raises or matches. The spec codes equal the SDK v2
 * `ProtocolErrorCode` members; `ConnectionClosed`/`RequestTimeout` are the v1 SDK's
 * numeric local codes, which v2 replaced with string `SdkErrorCode`s (issue #4678).
 */
export const ErrorCode = {
  ConnectionClosed: -32000,
  RequestTimeout: -32001,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/**
 * A JSON-RPC protocol error whose message keeps the `MCP error <code>: ` prefix the v1
 * SDK's `McpError` added (issue #4678). The v2 SDK's `ProtocolError` sends its message
 * unprefixed, so throwing it directly would change every error envelope on the wire;
 * this subclass keeps the wire byte-identical while still being a `ProtocolError` for
 * the SDK's own error handling.
 */
export class McpError extends ProtocolError {
  constructor(code: number, message: string, data?: unknown) {
    super(code, `MCP error ${code}: ${message}`, data);
    this.name = "McpError";
  }
}

/**
 * Normalizes an error raised by an SDK v2 `Client` call to the shape the v1 client
 * raised, so loopback forwarding keeps its existing messages and codes (issue #4678):
 * a server's JSON-RPC error and the local request-timeout / connection-closed errors
 * become a prefixed {@link McpError} with the v1 numeric code. Anything else is
 * returned unchanged.
 */
export function toV1ClientError(error: unknown): unknown {
  if (error instanceof McpError) {
    return error;
  }
  if (error instanceof ProtocolError) {
    return new McpError(error.code, error.message, error.data);
  }
  if (error instanceof SdkError) {
    if (error.code === SdkErrorCode.RequestTimeout) {
      return new McpError(ErrorCode.RequestTimeout, error.message, error.data);
    }
    if (error.code === SdkErrorCode.ConnectionClosed) {
      return new McpError(ErrorCode.ConnectionClosed, error.message, error.data);
    }
  }
  return error;
}

/**
 * Awaits an SDK v2 `Client` call and rethrows its failure in the v1 client shape (see
 * {@link toV1ClientError}), so a caller that reports or classifies the error — a
 * request timeout as code `-32001` with `"MCP error -32001: Request timed out"` — sees
 * what the v1 client raised (issue #4678).
 */
export async function withV1ClientErrors<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    throw toV1ClientError(error);
  }
}
