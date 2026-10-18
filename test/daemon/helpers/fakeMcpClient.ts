import { Client } from "@modelcontextprotocol/client";

/** The calls a forward makes that a test may answer itself; each keeps the SDK signature. */
export interface StubMcpClientHandlers {
  callTool?: Client["callTool"];
  listTools?: Client["listTools"];
  listResources?: Client["listResources"];
  listResourceTemplates?: Client["listResourceTemplates"];
  readResource?: Client["readResource"];
}

/**
 * An MCP `Client` (a real subclass, like `LoopbackMcpClient`) that answers the forwarded
 * calls from the supplied handlers and returns an empty answer for the rest. It is never
 * connected to a transport, so `close()` is a no-op.
 */
export class StubMcpClient extends Client {
  constructor(private readonly handlers: StubMcpClientHandlers = {}) {
    super({ name: "stub-mcp-client", version: "0.0.0" });
  }

  override async callTool(...args: Parameters<Client["callTool"]>): ReturnType<Client["callTool"]> {
    return this.handlers.callTool ? await this.handlers.callTool(...args) : { content: [] };
  }

  override async listTools(
    ...args: Parameters<Client["listTools"]>
  ): ReturnType<Client["listTools"]> {
    return this.handlers.listTools ? await this.handlers.listTools(...args) : { tools: [] };
  }

  override async listResources(
    ...args: Parameters<Client["listResources"]>
  ): ReturnType<Client["listResources"]> {
    return this.handlers.listResources
      ? await this.handlers.listResources(...args)
      : { resources: [] };
  }

  override async listResourceTemplates(
    ...args: Parameters<Client["listResourceTemplates"]>
  ): ReturnType<Client["listResourceTemplates"]> {
    return this.handlers.listResourceTemplates
      ? await this.handlers.listResourceTemplates(...args)
      : { resourceTemplates: [] };
  }

  override async readResource(
    ...args: Parameters<Client["readResource"]>
  ): ReturnType<Client["readResource"]> {
    return this.handlers.readResource
      ? await this.handlers.readResource(...args)
      : { contents: [] };
  }

  override async close(): Promise<void> {}
}
