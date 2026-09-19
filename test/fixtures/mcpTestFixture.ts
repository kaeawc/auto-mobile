import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AnySchema, SchemaOutput } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { createMcpServer } from "../../src/server/index";

export const MCP_TEST_REQUEST_TIMEOUT_MS = 4_000;

type McpClientRequest = Parameters<Client["request"]>[0];
type McpRequestOptions = Parameters<Client["request"]>[2];

// `Client.callTool()` delegates to `this.request()`, so this one typed override
// bounds every fixture MCP round trip. Keep it below the integration lane's 5s
// Bun timeout so a stalled request reports the SDK's RequestTimeout diagnostic.
class BoundedMcpTestClient extends Client {
  override request<T extends AnySchema>(
    request: McpClientRequest,
    resultSchema: T,
    options?: McpRequestOptions,
  ): Promise<SchemaOutput<T>> {
    return super.request(request, resultSchema, {
      ...options,
      timeout: options?.timeout ?? MCP_TEST_REQUEST_TIMEOUT_MS,
    });
  }
}

interface McpTestContext {
  server: ReturnType<typeof createMcpServer>;
  client: Client;
  serverTransport: any;
  clientTransport: any;
}

export class McpTestFixture {
  public server!: ReturnType<typeof createMcpServer>;
  public client!: Client;
  public serverTransport!: any;
  public clientTransport!: any;
  private readonly serverOptions: Parameters<typeof createMcpServer>[0];

  constructor(serverOptions: Parameters<typeof createMcpServer>[0] = {}) {
    const overrides = new Map<string, Map<string, boolean>>();
    this.serverOptions = {
      sessionToolSelectionService: {
        isEnabled: async (sessionUuid, toolName, declaredDefault) =>
          (sessionUuid ? overrides.get(sessionUuid)?.get(toolName) : undefined) ?? declaredDefault,
        getOverride: async (sessionUuid, toolName) => overrides.get(sessionUuid)?.get(toolName),
        setEnabled: async (sessionUuid, toolName, enabled) => {
          const sessionOverrides = overrides.get(sessionUuid) ?? new Map<string, boolean>();
          sessionOverrides.set(toolName, enabled);
          overrides.set(sessionUuid, sessionOverrides);
        },
        deleteSession: async (sessionUuid) => {
          overrides.delete(sessionUuid);
        },
      },
      ...serverOptions,
    };
  }

  async setup(): Promise<void> {
    const { createMcpServer } = await import("../../src/server/index");
    this.server = createMcpServer(this.serverOptions);
    [this.serverTransport, this.clientTransport] = InMemoryTransport.createLinkedPair();

    await this.server.connect(this.serverTransport);

    this.client = new BoundedMcpTestClient({
      name: "test-client",
      version: "0.0.1",
    });

    await this.client.connect(this.clientTransport);
  }

  async teardown(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
    // Explicitly close the server protocol too, so its request handlers,
    // subscriptions, and timeout state cannot outlive the fixture.
    if (this.server) {
      await this.server.close();
    }
  }

  getContext(): McpTestContext {
    return {
      server: this.server,
      client: this.client,
      serverTransport: this.serverTransport,
      clientTransport: this.clientTransport,
    };
  }
}
