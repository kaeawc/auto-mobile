import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod/v4";
import { createMcpServer } from "../../src/server/index";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { InMemoryToolSelectionProfileRegistry } from "../../src/server/toolSelectionProfileRegistry";
import { getToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { INTERNAL_ACTIONS_COMPACT_METADATA_PARAM } from "../../src/daemon/constants";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";

const TOOL = "__connection_metadata_probe__";
const clients: Client[] = [];
const servers: ReturnType<typeof createMcpServer>[] = [];
const registry = new InMemoryToolSelectionProfileRegistry();
let restore: () => void;
let previous: boolean;

beforeAll(async () => {
  restore = installHermeticServerFixture();
  previous = serverConfig.isActionsCompactMetadataEnabled();
  serverConfig.setActionsCompactMetadataEnabled(true);
  for (const sessionId of ["compact", "full", "default", "direct"]) {
    const server = createMcpServer({
      daemonMode: sessionId !== "direct",
      sessionContext: { sessionId },
      toolSelectionProfileRegistry: registry,
      sessionToolSelectionService: {
        isEnabled: async (_uuid, _tool, declaredDefault) => declaredDefault,
        setEnabled: async () => {},
        getOverride: async () => undefined,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: sessionId, version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    servers.push(server);
    clients.push(client);
  }
  // A fake handler reports the trusted context passed to real finalization.
  ToolRegistry.register(TOOL, "connection presentation probe", z.object({}), async () =>
    createStructuredToolResponse({ enabled: getToolSelectionContext()?.actionsCompactMetadata }),
  );
});

afterAll(async () => {
  for (const client of clients) {
    await client.close();
  }
  for (const server of servers) {
    await server.close();
  }
  Reflect.get(ToolRegistry, "tools").delete(TOOL);
  serverConfig.setActionsCompactMetadataEnabled(previous);
  restore();
});

async function preference(client: Client, enabled?: boolean) {
  return client.callTool({
    name: "setToolEnabled",
    arguments: {
      toolNames: ["setToolEnabled"],
      enabled: true,
      ...(enabled !== undefined ? { [INTERNAL_ACTIONS_COMPACT_METADATA_PARAM]: enabled } : {}),
    },
  });
}
async function read(client: Client, forged?: boolean) {
  const result = await client.callTool({
    name: TOOL,
    arguments: forged === undefined ? {} : { [INTERNAL_ACTIONS_COMPACT_METADATA_PARAM]: forged },
  });
  const content = result.content;
  if (!Array.isArray(content) || content[0]?.type !== "text") {
    throw new Error("Missing probe result");
  }
  return JSON.parse(content[0].text);
}

test("daemon ingress keeps opposite live preferences and falls back to the saved flag", async () => {
  await preference(clients[0], true);
  await preference(clients[1], false);
  expect(await read(clients[0])).toEqual({ enabled: true });
  expect(await read(clients[1])).toEqual({ enabled: false });
  expect(await read(clients[2])).toEqual({ enabled: true });
  serverConfig.setActionsCompactMetadataEnabled(false);
  expect(await read(clients[0])).toEqual({ enabled: true });
  expect(await read(clients[1])).toEqual({ enabled: false });
  expect(await read(clients[2])).toEqual({ enabled: false });
  expect(await read(clients[1], true)).toEqual({ enabled: false });
});

test("direct clients cannot forge the daemon presentation marker", async () => {
  serverConfig.setActionsCompactMetadataEnabled(true);
  await preference(clients[3], false);
  expect(await read(clients[3], false)).toEqual({ enabled: true });
});
