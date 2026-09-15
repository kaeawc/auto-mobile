import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ACCEPTANCE_DISCOVERY_CAPABILITY_ENV,
  DAEMON_VERSION,
  INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM,
  INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM,
} from "../../src/daemon/constants";
import { DaemonClient } from "../../src/daemon/client";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse, getStructuredField } from "../../src/utils/toolUtils";
import { z } from "zod/v4";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";

const TOOL = "__acceptance_discovery_capability_probe_7144__";
const NO_SCHEMA_TOOL = "__acceptance_discovery_no_schema_probe_7144__";
const CAPABILITY = "acceptance-harness-capability";

let isAvailableSpy: ReturnType<typeof spyOn> | undefined;
let configuredFixture: McpTestFixture;
let unconfiguredFixture: McpTestFixture;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("acceptance discovery presentation capability (issue #7144)", () => {
  beforeAll(async () => {
    ToolRegistry.register(
      TOOL,
      "reports whether the daemon accepted a trusted acceptance presentation order",
      z.object({}).strict(),
      async (args: unknown) =>
        createStructuredToolResponse({
          success: true,
          receivedOrder:
            (args as Record<string, unknown>)[INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM] ?? null,
        }),
      {
        outputSchema: z.object({
          success: z.boolean(),
          receivedOrder: z.enum(["forward", "reverse"]).nullable(),
        }),
      },
    );
    ToolRegistry.register(
      NO_SCHEMA_TOOL,
      "reports whether an authenticated acceptance request retains a no-schema payload",
      z.object({}).strict(),
      async () =>
        createStructuredToolResponse({
          success: true,
          source: "no-schema",
        }),
    );
    configuredFixture = new McpTestFixture({
      daemonMode: true,
      acceptanceDiscoveryCapability: CAPABILITY,
    });
    unconfiguredFixture = new McpTestFixture({ daemonMode: true });
    await Promise.all([configuredFixture.setup(), unconfiguredFixture.setup()]);
  });

  afterAll(async () => {
    await Promise.all([configuredFixture.teardown(), unconfiguredFixture.teardown()]);
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(TOOL);
    (ToolRegistry as unknown as { tools: Map<string, unknown> }).tools.delete(NO_SCHEMA_TOOL);
  });

  afterEach(() => {
    isAvailableSpy?.mockRestore();
    isAvailableSpy = undefined;
  });

  test("a normal daemon caller cannot forge the hidden presentation order", async () => {
    const result = await configuredFixture.client.callTool({
      name: TOOL,
      arguments: {
        [INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM]: "reverse",
        [INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM]: "ordinary-client-guess",
      },
    });

    expect(getStructuredField(result, "receivedOrder")).toBeNull();
  });

  test("a daemon without the harness capability ignores a normal caller argument", async () => {
    const result = await unconfiguredFixture.client.callTool({
      name: TOOL,
      arguments: {
        [INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM]: "forward",
        [INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM]: CAPABILITY,
      },
    });

    expect(getStructuredField(result, "receivedOrder")).toBeNull();
  });

  test("the live harness proxy overwrites a client-forged order with its configured capability", async () => {
    const priorLive = process.env.AUTOMOBILE_ACCEPTANCE_LIVE;
    const priorOrder = process.env.AUTOMOBILE_ACCEPTANCE_DISCOVERY_ORDER;
    const priorCapability = process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV];
    process.env.AUTOMOBILE_ACCEPTANCE_LIVE = "1";
    process.env.AUTOMOBILE_ACCEPTANCE_DISCOVERY_ORDER = "reverse";
    process.env[ACCEPTANCE_DISCOVERY_CAPABILITY_ENV] = CAPABILITY;

    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const daemon = new FakeDaemonClient();
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        autoStartDaemon: false,
        clientFactory: () => daemon,
        daemonManager,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "acceptance-capability-test", version: "0.0.1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({
        name: "listDevices",
        arguments: {
          [INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM]: "forward",
          [INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM]: "forged-by-client",
        },
      });

      expect(daemon.callToolCalls).toContainEqual({
        toolName: "listDevices",
        params: {
          [INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM]: "reverse",
          [INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM]: CAPABILITY,
        },
      });
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
      restoreEnv("AUTOMOBILE_ACCEPTANCE_LIVE", priorLive);
      restoreEnv("AUTOMOBILE_ACCEPTANCE_DISCOVERY_ORDER", priorOrder);
      restoreEnv(ACCEPTANCE_DISCOVERY_CAPABILITY_ENV, priorCapability);
    }
  });

  test("the daemon accepts an order only when its startup capability matches", async () => {
    const result = await configuredFixture.client.callTool({
      name: TOOL,
      arguments: {
        [INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM]: "reverse",
        [INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM]: CAPABILITY,
      },
    });

    expect(getStructuredField(result, "receivedOrder")).toBe("reverse");
  });

  test("retains no-schema structuredContent only for an authenticated acceptance request", async () => {
    const accepted = await configuredFixture.client.callTool({
      name: NO_SCHEMA_TOOL,
      arguments: {
        [INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM]: "forward",
        [INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM]: CAPABILITY,
      },
    });
    const ordinary = await configuredFixture.client.callTool({
      name: NO_SCHEMA_TOOL,
      arguments: {
        [INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM]: "forward",
        [INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM]: "ordinary-client-guess",
      },
    });

    expect(accepted.structuredContent).toEqual({ success: true, source: "no-schema" });
    expect(ordinary.structuredContent).toBeUndefined();
  });
});
