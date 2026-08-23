import { describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createMcpServer } from "../../src/server";
import { serverConfig } from "../../src/utils/ServerConfig";
import { setDebugModeEnabled } from "../../src/utils/debug";
import { compileJsonSchema } from "../helpers/jsonSchemaCompile";
import Ajv2020 from "ajv/dist/2020";

/**
 * Tool Registration Regression Tests
 *
 * These tests prevent the silent registration failure that occurred in issue #745,
 * where tools were defined but not registered with the MCP server.
 *
 * The in-file ToolRegistrationValidator unit suite was removed (issue #4181,
 * D1) — it exercised only its own fakes, reaching no src code. The integration
 * tests below validate the real registry and committed schema file.
 */

interface ToolSchemaDefinition {
  name: string;
  description: string;
  inputSchema: any;
  outputSchema?: Record<string, unknown>;
}

/**
 * Integration tests that validate actual tool registration
 */
describe("Tool Registration Validation (Integration Tests)", () => {
  // Import actual modules for integration testing
  const actualModules = {
    interaction: () => import("../../src/server/interactionTools"),
    app: () => import("../../src/server/appTools"),
    observe: () => import("../../src/server/observeTools"),
    device: () => import("../../src/server/deviceTools"),
    utility: () => import("../../src/server/utilityTools"),
    navigation: () => import("../../src/server/navigationTools"),
    notification: () => import("../../src/server/notificationTools"),
    highlight: () => import("../../src/server/highlightTools"),
    debug: () => import("../../src/server/debugTools"),
    deepLink: () => import("../../src/server/deepLinkTools"),
    biometric: () => import("../../src/server/biometricTools"),
    snapshot: () => import("../../src/server/snapshotTools"),
    videoRecording: () => import("../../src/server/videoRecordingTools"),
    criticalSection: () => import("../../src/server/criticalSectionTools"),
    doctor: () => import("../../src/server/doctorTools"),
    plan: () => import("../../src/server/planTools"),
  };

  // Integration tests verify actual code structure without needing the validator

  test("should verify critical tools from issue #745 exist in actual code", async () => {
    const interactionTools = await actualModules.interaction();
    const criticalSchemas = [
      "clearTextSchema",
      "selectAllTextSchema",
      "pressButtonSchema",
      "systemTraySchema",
    ];

    criticalSchemas.forEach((schemaName) => {
      expect(interactionTools).toHaveProperty(schemaName);
      expect(interactionTools[schemaName]).toBeDefined();
    });
  });

  test("should verify actual schema file exists and is valid JSON", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const schemaPath = path.join(process.cwd(), "schemas", "tool-definitions.json");

    const content = await fs.readFile(schemaPath, "utf-8");
    const schemas = JSON.parse(content);

    expect(Array.isArray(schemas)).toBe(true);
    expect(schemas.length).toBeGreaterThan(0);

    // Validate structure of first schema
    if (schemas.length > 0) {
      expect(schemas[0]).toHaveProperty("name");
      expect(schemas[0]).toHaveProperty("description");
      expect(schemas[0]).toHaveProperty("inputSchema");
    }
  });

  test("should keep generated observe outputSchema compilable by strict clients", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const schemaPath = path.join(process.cwd(), "schemas", "tool-definitions.json");

    const content = await fs.readFile(schemaPath, "utf-8");
    const schemas = JSON.parse(content) as ToolSchemaDefinition[];
    const observe = schemas.find((schema) => schema.name === "observe");

    expect(observe?.outputSchema).toBeDefined();
    expect(() => compileJsonSchema(observe!.outputSchema)).not.toThrow();
  });

  // R11 (issue #4183): the observe-only check above compiled a single schema.
  // Every committed input/output schema must be compilable by strict clients,
  // or a hand-edited schema slips through until a client rejects it at runtime.
  test("should keep every committed tool schema compilable by strict clients", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const schemaPath = path.join(process.cwd(), "schemas", "tool-definitions.json");

    const content = await fs.readFile(schemaPath, "utf-8");
    const schemas = JSON.parse(content) as ToolSchemaDefinition[];
    expect(schemas.length).toBeGreaterThan(0);

    for (const schema of schemas) {
      expect(
        () => compileJsonSchema(schema.inputSchema),
        `${schema.name} inputSchema`,
      ).not.toThrow();
      if (schema.outputSchema !== undefined) {
        expect(
          () => compileJsonSchema(schema.outputSchema),
          `${schema.name} outputSchema`,
        ).not.toThrow();
      }
    }
  });

  test("committed tapOn schema gates semantic link activation to plain taps", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const schemaPath = path.join(process.cwd(), "schemas", "tool-definitions.json");
    const schemas = JSON.parse(await fs.readFile(schemaPath, "utf-8")) as ToolSchemaDefinition[];
    const tapOn = schemas.find((schema) => schema.name === "tapOn");
    const validate = new Ajv2020({ strict: false }).compile(tapOn!.inputSchema);
    const baseInput = {
      selector: { accessibilityLink: "Terms of Service" },
    };

    expect(validate({ ...baseInput, platform: "android", action: "tap" })).toBe(true);
    expect(validate({ ...baseInput, platform: "ios", action: "tap" })).toBe(true);
    expect(validate({ ...baseInput, platform: "android", action: "focus" })).toBe(false);
    expect(validate({ ...baseInput, platform: "android", retryIfNoChange: true })).toBe(false);
  });

  // R9 (issue #4183): a negative assertion so the compile check cannot silently
  // pass on anything — a structurally-invalid schema (`type` not an allowed
  // keyword) must be rejected, proving compileJsonSchema is a real gate.
  test("compileJsonSchema rejects a structurally invalid schema", () => {
    expect(() => compileJsonSchema({ type: "not-a-json-schema-type" })).toThrow();
  });

  // A5 (issue #4181, rank 6): the previous test compared only NAMES, and only
  // in the served->committed direction. This checks BOTH directions and the
  // body/description bytes:
  //   1. served -> committed: every served tool has a committed entry.
  //   2. committed -> served: every committed name resolves as a live tool.
  //      The reverse direction uses getToolForPlan(), which resolves plan-only
  //      tools (barrier/criticalSection) too — they are deliberately absent
  //      from getToolDefinitions() (see A1) but present in the committed file,
  //      so a plan-inclusive roster is the correct comparison.
  //   3. body/description: each committed entry's description, inputSchema, and outputSchema
  //      deep-match the live definition (drift is 0 today).
  test("committed tool-definitions.json matches the live schemas in both directions", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const schemaPath = path.join(process.cwd(), "schemas", "tool-definitions.json");
    const originalEmbeddedSdkEnabled = serverConfig.isEmbeddedSdkEnabled();

    try {
      ToolRegistry.clearTools();
      serverConfig.setEmbeddedSdkEnabled(true);
      setDebugModeEnabled(true);
      createMcpServer({ daemonMode: true });

      const schemaContent = await fs.readFile(schemaPath, "utf-8");
      const committed = JSON.parse(schemaContent) as ToolSchemaDefinition[];
      const committedNames = new Set(committed.map((tool) => tool.name));
      const served = ToolRegistry.getToolDefinitions();
      const servedNames = served.map((tool) => tool.name);

      // 1. served -> committed
      expect(servedNames.filter((name) => !committedNames.has(name))).toEqual([]);

      // 2. committed -> served (plan-only tools resolve via getToolForPlan)
      const orphanedCommitted = committed
        .map((tool) => tool.name)
        .filter((name) => ToolRegistry.getToolForPlan(name) === undefined);
      expect(orphanedCommitted).toEqual([]);

      // 3. body/description byte-match for every served tool
      const committedByName = new Map(committed.map((tool) => [tool.name, tool]));
      for (const liveDef of served) {
        const committedDef = committedByName.get(liveDef.name);
        expect(committedDef, `${liveDef.name} missing from committed file`).toBeDefined();
        expect(committedDef!.description).toBe(liveDef.description);
        expect(committedDef!.inputSchema).toEqual(
          liveDef.inputSchema as ToolSchemaDefinition["inputSchema"],
        );
        expect(committedDef!.outputSchema).toEqual(
          liveDef.outputSchema as ToolSchemaDefinition["outputSchema"],
        );
      }
    } finally {
      ToolRegistry.clearTools();
      serverConfig.setEmbeddedSdkEnabled(originalEmbeddedSdkEnabled);
      setDebugModeEnabled(false);
    }
  });

  // D2 (issue #4181, rank 15): the "verify actual ToolRegistry has expected
  // methods" test (toHaveProperty + typeof on a method the suite already
  // calls) was a restatement removed as a tautology.
});
