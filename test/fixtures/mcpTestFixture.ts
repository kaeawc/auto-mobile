import {
  type JsonSchemaType,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
  type Request,
  type RequestMethod,
  type RequestOptions,
  type ResultTypeMap,
  type StandardSchemaV1,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { createMcpServer } from "../../src/server/index";
import { Client } from "../helpers/v1ViewMcpClient";

export const MCP_TEST_REQUEST_TIMEOUT_MS = 4_000;

function bounded(options: RequestOptions | undefined): RequestOptions {
  return { ...options, timeout: options?.timeout ?? MCP_TEST_REQUEST_TIMEOUT_MS };
}

function isResultSchema(
  value: StandardSchemaV1 | RequestOptions | undefined,
): value is StandardSchemaV1 {
  return value !== undefined && "~standard" in value;
}

// `Client.callTool()` delegates to `this.request()`, so this one typed override
// bounds every fixture MCP round trip. Keep it below the integration lane's 5s
// Bun timeout so a stalled request reports the SDK's RequestTimeout diagnostic.
class BoundedMcpTestClient extends Client {
  override request<M extends RequestMethod>(
    request: { method: M; params?: Record<string, unknown> },
    options?: RequestOptions,
  ): Promise<ResultTypeMap[M]>;
  override request<T extends StandardSchemaV1>(
    request: Request,
    resultSchema: T,
    options?: RequestOptions,
  ): Promise<StandardSchemaV1.InferOutput<T>>;
  override request(
    request: { method: RequestMethod; params?: Record<string, unknown> },
    schemaOrOptions?: StandardSchemaV1 | RequestOptions,
    maybeOptions?: RequestOptions,
  ): Promise<unknown> {
    if (isResultSchema(schemaOrOptions)) {
      return super.request(request, schemaOrOptions, bounded(maybeOptions));
    }
    return super.request(request, bounded(schemaOrOptions));
  }
}

// The SDK client recompiles every advertised output schema with Ajv on each
// `listTools()`, and a large one (prototype's is ~70 KB) costs tens of ms per
// compile. Memoize the SAME Ajv validator by schema content for the whole test
// process, so a re-list reuses it; validation itself is unchanged.
class MemoizedJsonSchemaValidator implements jsonSchemaValidator {
  private readonly ajv = new AjvJsonSchemaValidator();
  private readonly validators = new Map<string, JsonSchemaValidator<unknown>>();

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const key = JSON.stringify(schema);
    let validator = this.validators.get(key);
    if (!validator) {
      validator = this.ajv.getValidator<unknown>(schema);
      this.validators.set(key, validator);
    }
    return validator as JsonSchemaValidator<T>;
  }
}

const fixtureOutputSchemaValidator = new MemoizedJsonSchemaValidator();

/**
 * Compile `schemas` into the fixture clients' shared validator cache ahead of time (e.g. in
 * `beforeAll`), so the first `listTools()` that advertises them does not pay the Ajv compile.
 */
export function precompileMcpOutputSchemas(schemas: readonly (object | undefined)[]): void {
  for (const schema of schemas) {
    if (schema) {
      fixtureOutputSchemaValidator.getValidator(schema as JsonSchemaType);
    }
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

    this.client = new BoundedMcpTestClient(
      {
        name: "test-client",
        version: "0.0.1",
      },
      { jsonSchemaValidator: fixtureOutputSchemaValidator },
    );

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
