import {
  Client,
  type Request,
  type RequestMethod,
  type RequestOptions,
  type ResultTypeMap,
  SdkError,
  SdkErrorCode,
  type StandardSchemaV1,
} from "@modelcontextprotocol/client";
import { toV1ClientError } from "../mcpError";

/**
 * The SDK v2 `Client` the control socket forwards through to the daemon's loopback MCP
 * server, with the v1 client's error contract (issue #4678):
 *
 * - an abort through the caller's `signal` rejects with the signal's own `reason`
 *   (e.g. a `ClientRequestCancellation`), not the SDK v2 `SdkError` wrapper, so
 *   cancellation identity checks downstream keep matching;
 * - a server JSON-RPC error, a request timeout, and a closed connection reject with a
 *   prefixed {@link McpError} carrying the v1 numeric code, so the messages and codes
 *   forwarded on the socket wire are unchanged.
 */
export class LoopbackMcpClient extends Client {
  override request<M extends RequestMethod>(
    request: { method: M; params?: Record<string, unknown> },
    options?: RequestOptions,
  ): Promise<ResultTypeMap[M]>;
  override request<T extends StandardSchemaV1>(
    request: Request,
    resultSchema: T,
    options?: RequestOptions,
  ): Promise<StandardSchemaV1.InferOutput<T>>;
  override async request(
    request: { method: RequestMethod; params?: Record<string, unknown> },
    schemaOrOptions?: StandardSchemaV1 | RequestOptions,
    maybeOptions?: RequestOptions,
  ): Promise<unknown> {
    if (isResultSchema(schemaOrOptions)) {
      return await withV1Errors(maybeOptions?.signal, () =>
        super.request(request, schemaOrOptions, maybeOptions),
      );
    }
    return await withV1Errors(schemaOrOptions?.signal, () =>
      super.request(request, schemaOrOptions),
    );
  }

  override async callTool(...args: Parameters<Client["callTool"]>): ReturnType<Client["callTool"]> {
    return await withV1Errors(args[1]?.signal, () => super.callTool(...args));
  }

  override async listTools(
    ...args: Parameters<Client["listTools"]>
  ): ReturnType<Client["listTools"]> {
    return await withV1Errors(args[1]?.signal, () => super.listTools(...args));
  }

  override async listResources(
    ...args: Parameters<Client["listResources"]>
  ): ReturnType<Client["listResources"]> {
    return await withV1Errors(args[1]?.signal, () => super.listResources(...args));
  }

  override async listResourceTemplates(
    ...args: Parameters<Client["listResourceTemplates"]>
  ): ReturnType<Client["listResourceTemplates"]> {
    return await withV1Errors(args[1]?.signal, () => super.listResourceTemplates(...args));
  }

  override async readResource(
    ...args: Parameters<Client["readResource"]>
  ): ReturnType<Client["readResource"]> {
    return await withV1Errors(args[1]?.signal, () => super.readResource(...args));
  }
}

function isResultSchema(
  value: StandardSchemaV1 | RequestOptions | undefined,
): value is StandardSchemaV1 {
  return value !== undefined && "~standard" in value;
}

async function withV1Errors<T>(
  signal: AbortSignal | undefined,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (
      signal?.aborted &&
      error instanceof SdkError &&
      error.code === SdkErrorCode.RequestTimeout &&
      !(signal.reason instanceof SdkError)
    ) {
      throw signal.reason;
    }
    throw toV1ClientError(error);
  }
}
