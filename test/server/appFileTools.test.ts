import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { registerAppFileTools } from "../../src/server/appFileTools";
import { ToolRegistry } from "../../src/server/toolRegistry";

describe("App file tools", () => {
  beforeEach(() => {
    (ToolRegistry as any).tools.clear();
  });

  afterEach(() => {
    (ToolRegistry as any).tools.clear();
  });

  test("registers putAppFile with discoverable schema fields", () => {
    registerAppFileTools();

    const toolDefinition = ToolRegistry.getToolDefinitions().find(
      (tool) => tool.name === "putAppFile",
    );
    expect(toolDefinition).toBeDefined();
    expect(toolDefinition!.inputSchema.properties.target).toBeDefined();
    expect(toolDefinition!.inputSchema.properties.files).toBeDefined();
    expect(toolDefinition!.inputSchema.properties.appId).toBeUndefined();
    expect(toolDefinition!.inputSchema.properties.container).toBeUndefined();
    expect(toolDefinition!.inputSchema.properties.destinationPath).toBeUndefined();

    const validate = new Ajv2020({ strict: false }).compile(toolDefinition!.inputSchema);
    const target = { domain: "app_containers", appId: "com.example.app", container: "documents" };
    expect(validate({ target, files: [{ destinationPath: "missing-source.txt" }] })).toBe(false);
    expect(
      validate({
        target,
        files: [
          { destinationPath: "multiple-sources.txt", contentText: "x", contentBase64: "eA==" },
        ],
      }),
    ).toBe(false);
    expect(
      validate({ target, files: [{ destinationPath: "one-source.txt", contentText: "x" }] }),
    ).toBe(true);
  });

  test("accepts a canonical local-source batch with nested destination paths", () => {
    registerAppFileTools();
    const tool = ToolRegistry.getTool("putAppFile");

    expect(
      tool!.schema.parse({
        platform: "ios",
        target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
        files: [
          {
            sourcePath: "/Users/me/fixtures/welcome.png",
            destinationPath: "fixtures/onboarding/welcome image.png",
          },
        ],
      }),
    ).toMatchObject({
      target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
      files: [{ destinationPath: "fixtures/onboarding/welcome image.png" }],
    });
  });

  test("accepts inline text and base64 binary content independently", () => {
    registerAppFileTools();
    const tool = ToolRegistry.getTool("putAppFile");

    expect(() =>
      tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        container: "documents",
        contentText: '{"enabled":false}',
        destinationPath: "config/experiments.json",
      }),
    ).not.toThrow();

    expect(() =>
      tool!.schema.parse({
        platform: "android",
        appId: "com.example.app",
        container: "cache",
        contentBase64: Buffer.from([0, 1, 2, 255]).toString("base64"),
        destinationPath: "images/raw.bin",
      }),
    ).not.toThrow();
  });

  test("rejects invalid source combinations with actionable messages", () => {
    registerAppFileTools();
    const tool = ToolRegistry.getTool("putAppFile");

    const bothSources = tool!.schema.safeParse({
      platform: "android",
      appId: "com.example.app",
      container: "documents",
      sourcePath: "/tmp/a.json",
      contentText: "{}",
      destinationPath: "config/a.json",
    });
    expect(bothSources.success).toBe(false);
    expect(bothSources.error!.issues[0].message).toContain("Provide exactly one");

    const noSource = tool!.schema.safeParse({
      platform: "android",
      appId: "com.example.app",
      container: "documents",
      destinationPath: "config/a.json",
    });
    expect(noSource.success).toBe(false);
    expect(noSource.error!.issues[0].message).toContain("Provide exactly one");
  });

  test("rejects unsafe destination paths", () => {
    registerAppFileTools();
    const tool = ToolRegistry.getTool("putAppFile");

    for (const destinationPath of [
      "/absolute/file.txt",
      "../escape.txt",
      "safe/../../escape.txt",
      "",
    ]) {
      const result = tool!.schema.safeParse({
        platform: "android",
        appId: "com.example.app",
        container: "documents",
        contentText: "x",
        destinationPath,
      });
      expect(result.success).toBe(false);
      expect(result.error!.issues[0].message).toContain("relative path");
    }
  });
});
