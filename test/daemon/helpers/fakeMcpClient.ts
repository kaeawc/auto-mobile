import type { Client } from "@modelcontextprotocol/client";

/**
 * The single narrowing point for MCP client test doubles. `mcpClientFactory` returns the
 * SDK's concrete `Client`; a stub implementing only the calls a test forwards cannot satisfy
 * that class structurally. An `object` -> class assertion is legal, so no cast through
 * `unknown` is needed at call sites.
 */
export function asMcpClient(stub: object): Client {
  return stub as Client;
}
