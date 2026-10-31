import { describe, expect, test } from "bun:test";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import {
  createSdkMcpServer,
  SERVER_INSTRUCTIONS,
  serverInstructions,
} from "../../src/server/sdkMcpServer";

const INITIALIZE = {
  jsonrpc: "2.0",
  id: "init",
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "instructions-test", version: "1" },
  },
} as const satisfies JSONRPCMessage;

/** The `initialize` result a server built with these instructions answers. */
async function initializeResult(
  instructions: string | undefined,
): Promise<Record<string, unknown>> {
  const server = createSdkMcpServer(
    { name: "AutoMobile", version: "0.0.0" },
    { tools: {} },
    { instructions },
  );
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const answered = new Promise<Record<string, unknown>>((resolve) => {
    clientTransport.onmessage = (frame) => {
      if ("result" in frame) {
        resolve(frame.result);
      }
    };
  });
  await server.connect(serverTransport);
  await clientTransport.start();
  try {
    await clientTransport.send(INITIALIZE);
    return await answered;
  } finally {
    await server.close();
  }
}

describe("serverInstructions", () => {
  test("is absent by default", () => {
    expect(serverInstructions({})).toBeUndefined();
  });

  test("is absent when the variable is off", () => {
    expect(serverInstructions({ AUTOMOBILE_SERVER_INSTRUCTIONS: "0" })).toBeUndefined();
  });

  test("returns the block when the variable is on", () => {
    expect(serverInstructions({ AUTOMOBILE_SERVER_INSTRUCTIONS: "1" })).toBe(SERVER_INSTRUCTIONS);
    expect(serverInstructions({ AUTOMOBILE_SERVER_INSTRUCTIONS: "true" })).toBe(
      SERVER_INSTRUCTIONS,
    );
  });

  test("the block stays short and points at the usage skill", () => {
    // About 93 tokens; the owner's cap for the A/B is roughly 150.
    expect(SERVER_INSTRUCTIONS.split(/\s+/).length).toBeLessThanOrEqual(80);
    expect(SERVER_INSTRUCTIONS).toContain("skill://auto-mobile-usage/SKILL.md");
  });
});

describe("initialize", () => {
  test("omits instructions by default", async () => {
    expect(process.env.AUTOMOBILE_SERVER_INSTRUCTIONS).toBeUndefined();
    const result = await initializeResult(undefined);
    expect("instructions" in result).toBe(false);
  });

  test("reads the variable when the caller passes nothing", async () => {
    const previous = process.env.AUTOMOBILE_SERVER_INSTRUCTIONS;
    process.env.AUTOMOBILE_SERVER_INSTRUCTIONS = "1";
    try {
      const result = await initializeResult(undefined);
      expect(result.instructions).toBe(SERVER_INSTRUCTIONS);
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_SERVER_INSTRUCTIONS;
      } else {
        process.env.AUTOMOBILE_SERVER_INSTRUCTIONS = previous;
      }
    }
  });

  test("carries the instructions when given", async () => {
    const result = await initializeResult(SERVER_INSTRUCTIONS);
    expect(result.instructions).toBe(SERVER_INSTRUCTIONS);
  });
});

describe("the block names only advertised tools", () => {
  test("every tool it names is in the advertised tool definitions", async () => {
    const definitions: { name: string }[] = await Bun.file(
      new URL("../../schemas/tool-definitions.json", import.meta.url),
    ).json();
    const advertised = new Set(definitions.map((tool) => tool.name));
    for (const name of ["listDevices", "getAndroid", "getApple", "observe", "tapOn", "sendKeys"]) {
      expect(SERVER_INSTRUCTIONS).toContain(name);
      expect(advertised.has(name)).toBe(true);
    }
  });
});
