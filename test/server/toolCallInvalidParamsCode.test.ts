import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import { daemonResponseError } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { prototypeSchema } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { formatToolParamError } from "../../src/utils/toolParamError";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { McpTestFixture } from "../fixtures/mcpTestFixture";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";

const INTERNAL_TOOL = "__invalid_params_internal_failure__";
const UNKNOWN_TOOL = "__invalid_params_unknown__";
const validationCases = [
  { label: "missing required parameter", name: "sendKeys", args: {}, fragment: "commands" },
  {
    label: "wrong type",
    name: "sendKeys",
    args: { commands: "hello" },
    fragment: "commands expected array, received string",
  },
  {
    label: "unknown enum value",
    name: "pressButton",
    args: { button: "invalid" },
    fragment: "button",
  },
  {
    label: "strict selector property",
    name: "tapOn",
    args: { selector: { text: "OK", index: 1 } },
    fragment: 'Unrecognized key: "index"',
  },
];

describe("invalid tool params use the SDK invalid-params code", () => {
  const fixtures = [new McpTestFixture(), new McpTestFixture({ daemonMode: true })];
  let restore: () => void;
  let proxyClient: Client;
  let closeProxy: () => Promise<void>;
  const daemonMessage = "MCP error -32602: Invalid parameters for tool tapOn: selector invalid";
  const daemonClient = new FakeDaemonClient({
    onCallTool: () => {
      throw daemonResponseError({
        id: "invalid-params-response",
        success: false,
        code: ErrorCode.InvalidParams,
        error: daemonMessage,
      });
    },
  });

  beforeAll(async () => {
    restore = installHermeticServerFixture();
    ToolRegistry.register(INTERNAL_TOOL, "Internal failure probe", z.object({}), async () => {
      throw new Error("genuine internal failure");
    });
    for (const fixture of fixtures) {
      await fixture.setup();
      // Warm dispatch outside the per-test timing budget.
      await fixture.client.callTool({ name: INTERNAL_TOOL, arguments: {} });
    }
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer: new FakeTimer(),
        clientFactory: () => daemonClient,
        daemonManager: manager,
        daemonAvailabilityProbe: async () => true,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    proxyClient = new Client({ name: "invalid-params-proxy", version: "1" });
    await server.connect(serverTransport);
    await proxyClient.connect(clientTransport);
    closeProxy = async () => {
      await proxyClient.close();
      await server.close();
      await proxy.close();
    };
    await proxyClient.callTool({ name: "tapOn", arguments: {} });
  });

  afterAll(async () => {
    await closeProxy?.();
    for (const fixture of fixtures) {
      await fixture.teardown();
    }
    restore();
  });

  for (const [index, mode] of ["direct", "daemon MCP endpoint"].entries()) {
    test.each(validationCases)(`${mode}: $label`, async ({ name, args, fragment }) => {
      const schema = ToolRegistry.getRegisteredTool(name)!.schema;
      const parsed = schema.safeParse(args);
      expect(parsed.success).toBe(false);
      const message = `Invalid parameters for tool ${name}: ${formatToolParamError(name, parsed.error, args, schema)}`;
      expect(message).toContain(fragment);
      const error = await fixtures[index].client
        .callTool({ name, arguments: args })
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({
        code: ErrorCode.InvalidParams,
        message: `MCP error -32602: ${message}`,
      });
    });

    test.each([
      { name: "getApple", args: { udid: "fake-ios-device", enableTools: ["networkCondition"] } },
      { name: "setToolEnabled", args: { toolName: "networkCondition" } },
      { name: "setToolEnabled", args: { toolNames: ["notATool", "networkCondition"] } },
    ])(`${mode}: $name rejects non-configurable names`, async ({ name, args }) => {
      const message =
        "toolNames" in args
          ? "Tools 'notATool', 'networkCondition' are not user-configurable."
          : "Tool 'networkCondition' is not user-configurable.";
      const error = await fixtures[index].client
        .callTool({ name, arguments: args })
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(McpError);
      expect(error).toMatchObject({ code: -32602, message: `MCP error -32602: ${message}` });
    });

    test(`${mode}: genuine handler failure keeps its isError shape`, async () => {
      expect(await fixtures[index].client.callTool({ name: INTERNAL_TOOL })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Error: genuine internal failure" }],
      });
    });

    test(`${mode}: unknown tool keeps internal-error code`, async () => {
      const error = await fixtures[index].client
        .callTool({ name: UNKNOWN_TOOL })
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        code: -32603,
        message: `MCP error -32603: Unknown tool: ${UNKNOWN_TOOL}`,
      });
    });
  }

  test("a non-Zod schema throw keeps the internal-error code and message", async () => {
    const schema = ToolRegistry.getRegisteredTool(INTERNAL_TOOL)!.schema;
    const parse = spyOn(schema, "parse").mockImplementation(() => {
      throw new Error("schema failed internally");
    });
    try {
      const error = await fixtures[0].client
        .callTool({ name: INTERNAL_TOOL })
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        code: -32603,
        message: `MCP error -32603: Invalid parameters for tool ${INTERNAL_TOOL}: Error: schema failed internally`,
      });
    } finally {
      parse.mockRestore();
    }
  });

  test("forwarded numeric invalid-params frame remains an isError result", async () => {
    expect(await proxyClient.callTool({ name: "tapOn", arguments: {} })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: `Error: ${daemonMessage}` }],
    });
  });
});

describe("validation message hygiene", () => {
  test("a custom message already naming its path is not prefixed twice", () => {
    const error = new z.ZodError([
      {
        code: "custom",
        path: ["layer"],
        message: "layer requires a selector naming the field to focus",
      },
    ]);
    expect(formatToolParamError("sendKeys", error)).toBe(
      "layer requires a selector naming the field to focus",
    );
  });

  test("a similar word does not suppress the path", () => {
    const error = new z.ZodError([
      { code: "custom", path: ["layer"], message: "layers are invalid" },
    ]);
    expect(formatToolParamError("sendKeys", error)).toBe("layer layers are invalid");
  });

  test("invalid inline prototype spec does not claim the spec was omitted", () => {
    const args = { action: "show", spec: { root: { name: "invalid" } } };
    const result = prototypeSchema.safeParse(args);
    expect(result.success).toBe(false);
    const message = formatToolParamError("prototype", result.error, args, prototypeSchema);
    expect(message).toContain("Invalid prototype at spec.");
    expect(message).not.toContain("show requires exactly one of spec or specPath");
  });

  test("omitted prototype spec still explains the required choice", () => {
    const args = { action: "show" };
    const result = prototypeSchema.safeParse(args);
    expect(result.success).toBe(false);
    expect(formatToolParamError("prototype", result.error, args, prototypeSchema)).toContain(
      "show requires exactly one of spec or specPath",
    );
  });
});
