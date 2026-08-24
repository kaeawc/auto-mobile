import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../../src/server/deviceTools";
import { createMcpServer } from "../../../src/server/index";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { DeviceInfo } from "../../../src/models";
import { McpTestFixture } from "../../fixtures/mcpTestFixture";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { compileJsonSchema } from "../../helpers/jsonSchemaCompile";
import { z } from "zod/v4";

// Issue #4181, rank 5 (R1): populate the registry at MODULE scope so a
// collection-time test.each iterates over real advertised tools. Building the
// table inside a describe/beforeAll would run the table factory against an
// EMPTY registry (describe bodies evaluate at collection time, before
// beforeAll) and silently produce ZERO tests — the refuted remedy.
createMcpServer();
const ADVERTISED_TOOLS = ToolRegistry.getToolDefinitions();

describe("MCP Tools inputSchema compiles under Ajv 2020 (issue #4181 rank 5)", () => {
  test("the advertised roster is non-empty (guards against a zero-test table)", () => {
    expect(ADVERTISED_TOOLS.length).toBeGreaterThan(0);
  });

  test.each(ADVERTISED_TOOLS.map((tool) => [tool.name, tool.inputSchema] as const))(
    "%s inputSchema is a valid JSON Schema Ajv 2020 can compile",
    (_name, inputSchema) => {
      // A malformed/invalid schema throws here; the old `typeof`/`hasType ||
      // hasCombinator` loop (with hasCombinator provably always false, #16)
      // could not detect an Ajv-invalid schema.
      expect(() => compileJsonSchema(inputSchema)).not.toThrow();
    },
  );
});

describe("MCP Tools Schema", () => {
  let fixture: McpTestFixture;
  let fakeDeviceUtils: FakeDeviceUtils;

  beforeAll(async () => {
    fakeDeviceUtils = new FakeDeviceUtils();
    const androidDevices: DeviceInfo[] = [
      { name: "Pixel_6_API_34", platform: "android", isRunning: false, source: "local" },
    ];
    fakeDeviceUtils.setDeviceImages("android", androidDevices);
    setDeviceToolsDependencies({
      deviceManagerFactory: () => fakeDeviceUtils,
    });

    fixture = new McpTestFixture();
    await fixture.setup();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.teardown();
    }
    resetDeviceToolsDependencies();
  });

  test("every advertised tool carries the required MCP metadata", () => {
    const toolDefinitions = ToolRegistry.getToolDefinitions();

    toolDefinitions.forEach((tool) => {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.inputSchema).toBe("object");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);

      // #16 (issue #4181): the previous `hasType || hasCombinator` guard had a
      // provably-dead second operand — the "should not publish top-level schema
      // combinators" test below asserts every top-level anyOf/oneOf/allOf is
      // undefined, so hasCombinator was always false. Assert `type` directly.
      const schema = tool.inputSchema as any;
      expect(Object.prototype.hasOwnProperty.call(schema, "type")).toBe(true);
      if (schema.type === "object") {
        expect(schema).toHaveProperty("properties");
      }
    });
  });

  test("should not publish top-level schema combinators", () => {
    const toolDefinitions = ToolRegistry.getToolDefinitions();

    for (const tool of toolDefinitions) {
      const schema = tool.inputSchema as any;
      expect(schema.anyOf, `${tool.name} should not publish top-level anyOf`).toBeUndefined();
      expect(schema.oneOf, `${tool.name} should not publish top-level oneOf`).toBeUndefined();
      expect(schema.allOf, `${tool.name} should not publish top-level allOf`).toBeUndefined();
    }
  });

  test("given a request that matches valid schema, should return a valid response", async function () {
    const { client } = fixture.getContext();

    const toolResponseSchema = z
      .object({
        content: z
          .array(
            z.object({
              type: z.string(),
              text: z.string().optional(),
            }),
          )
          .optional(),
      })
      .passthrough();

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "listDeviceImages",
          arguments: {
            platform: "android",
          },
        },
      },
      toolResponseSchema,
    );

    expect(typeof result).toBe("object");
  });

  // D8 (issue #4181): the "omits optional fields" test was byte-identical to
  // the "matches valid schema" test above (same listDeviceImages call, same
  // assertion) — removed as a pure duplicate.

  // D9 (issue #4181): the old "contains fields not defined by the schema"
  // test was unfalsifiable — its try/catch accepted BOTH a success and a
  // validation error, so it passed on every branch. The proposed replacement
  // ("strict schemas reject it") was REFUTED: listDeviceImages actually
  // ACCEPTS unlisted top-level fields. Pin that real, falsifiable behavior —
  // if listDeviceImages ever became strict this row reds.
  test("listDeviceImages accepts an unlisted top-level field (its schema is permissive)", async function () {
    const { client } = fixture.getContext();

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "listDeviceImages",
          arguments: {
            platform: "android",
            unknownField: "ignored, not rejected",
          },
        },
      },
      z.object({ content: z.array(z.any()).optional() }).passthrough(),
    );

    expect(typeof result).toBe("object");
  });

  test("tapOn rejects a defined field with the wrong type", async function () {
    const { client } = fixture.getContext();

    // Test tapOn with string instead of number
    try {
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "tapOn",
            arguments: {
              x: "not a number",
              y: 200,
            },
          },
        },
        z.any(),
      );
      expect.fail("Should have thrown an error for incorrect type");
    } catch (error: any) {
      expect(error.message).toContain("Invalid parameters");
    }
  });

  test("tapOn should report helpful errors for malformed container", async () => {
    const { client } = fixture.getContext();

    try {
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "tapOn",
            arguments: {
              platform: "android",
              selector: { text: "Duluth" },
              container: "MN",
            },
          },
        },
        z.any(),
      );
      expect.fail("Should have thrown an error for invalid container");
    } catch (error: any) {
      expect(error.message).toContain("container expected object");
    }
  });

  test("tapOn should default action to 'tap' when omitted", async () => {
    const { tapOnSchema } = await import("../../../src/server/interactionTools");
    const result = tapOnSchema.parse({ platform: "android", selector: { text: "Online" } });
    expect(result.action).toBe("tap");
  });

  test("an unknown tool name is rejected with an Unknown tool error", async function () {
    const { client } = fixture.getContext();

    // NAME (issue #4181): the old title claimed "fields ... have incorrect
    // values" but the body calls a nonexistent tool and asserts "Unknown tool".
    try {
      const { z } = await import("zod");
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "nonExistentTool",
            arguments: {},
          },
        },
        z.any(),
      );
      expect.fail("Should have thrown an error for unknown tool");
    } catch (error: any) {
      // This should fail because the tool doesn't exist
      expect(error.message).toContain("Unknown tool");
    }
  });
});
