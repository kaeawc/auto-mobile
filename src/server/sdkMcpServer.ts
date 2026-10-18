import {
  type Implementation,
  McpServer,
  type ServerCapabilities,
} from "@modelcontextprotocol/server";

/**
 * Builds an SDK v2 `McpServer` that advertises exactly `capabilities` (issue #4678).
 *
 * Given `prompts` at construction, the v2 `McpServer` installs its own prompts handlers
 * and advertises `prompts.listChanged: true`; the v1 server did neither. Our servers
 * answer `prompts/list` themselves, so `prompts` is registered after construction
 * instead, keeping the `initialize` result byte-identical (same value, same key order).
 */
export function createSdkMcpServer(
  info: Implementation,
  capabilities: ServerCapabilities,
): McpServer {
  const server = new McpServer(info, { capabilities: { ...capabilities, prompts: undefined } });
  if (capabilities.prompts) {
    server.server.registerCapabilities({ prompts: capabilities.prompts });
  }
  return server;
}
