import type {
  HandlerResultTypeMap,
  RequestTypeMap,
  Server,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from "@modelcontextprotocol/server";

/** Request methods `ResourceRegistry` installs handlers for. */
export type ResourceRegistryRequestMethod =
  | "resources/list"
  | "resources/read"
  | "resources/templates/list"
  | "resources/subscribe"
  | "resources/unsubscribe";

/**
 * The slice of the SDK's low-level `Server` the registries touch. Both the real
 * the real `McpServer.server` and `FakeUnderlyingServer` satisfy it structurally, so
 * tests need no cast to hand a fake to `registerWithServer`.
 */
export interface RegistryUnderlyingServer extends Pick<Server, "notification"> {
  onclose?: (() => void) | undefined;
  setRequestHandler<M extends ResourceRegistryRequestMethod>(
    method: M,
    handler: (
      request: RequestTypeMap[M],
      ctx: ServerContext,
    ) => HandlerResultTypeMap[M] | Promise<HandlerResultTypeMap[M]>,
  ): void;
}

/** What `ResourceRegistry` needs from an MCP server. */
export interface ResourceRegistryHost {
  readonly server: RegistryUnderlyingServer;
}

/** The schema type `ToolRegistry` hands the SDK when advertising a tool. */
export type ToolRegistrySchema = StandardSchemaWithJSON;

/** What `ToolRegistry` needs from an MCP server. */
export interface ToolRegistryHost {
  readonly server: Pick<RegistryUnderlyingServer, "onclose">;
  registerTool(
    name: string,
    config: {
      title?: string;
      annotations?: ToolAnnotations;
      description?: string;
      inputSchema?: ToolRegistrySchema;
      _meta?: Record<string, unknown>;
    },
    callback: () => Promise<never>,
  ): unknown;
  sendToolListChanged(): void;
}
