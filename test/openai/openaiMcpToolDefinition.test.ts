import { describe, expect, test } from "bun:test";
import { createOpenAIMcpToolDefinition, parseOpenAIMcpToolCliArgs } from "../../src/openai";

describe("createOpenAIMcpToolDefinition", () => {
  test("creates a default AutoMobile MCP tool declaration", () => {
    expect(createOpenAIMcpToolDefinition({
      serverUrl: "https://example.com/auto-mobile/mcp",
    })).toEqual({
      type: "mcp",
      server_label: "auto-mobile",
      server_description: "AutoMobile mobile device automation tools for Android and iOS.",
      server_url: "https://example.com/auto-mobile/mcp",
    });
  });

  test("adds OpenAI tool search and approval fields when requested", () => {
    expect(createOpenAIMcpToolDefinition({
      serverUrl: "https://example.com/mcp",
      serverLabel: "mobile",
      serverDescription: "Mobile automation",
      deferLoading: true,
      requireApproval: "never",
    })).toEqual({
      type: "mcp",
      server_label: "mobile",
      server_description: "Mobile automation",
      server_url: "https://example.com/mcp",
      defer_loading: true,
      require_approval: "never",
    });
  });

  test("rejects invalid URLs", () => {
    expect(() => createOpenAIMcpToolDefinition({
      serverUrl: "not a url",
    })).toThrow("Invalid OpenAI MCP server URL");

    expect(() => createOpenAIMcpToolDefinition({
      serverUrl: "file:///tmp/mcp",
    })).toThrow("must use http or https");
  });
});

describe("generate-openai-mcp-tool parseArgs", () => {
  test("parses tool search options", () => {
    expect(parseOpenAIMcpToolCliArgs([
      "--server-url",
      "https://example.com/mcp",
      "--server-label",
      "auto-mobile-dev",
      "--defer-loading",
      "--require-approval",
      "always",
    ])).toEqual({
      serverUrl: "https://example.com/mcp",
      serverLabel: "auto-mobile-dev",
      deferLoading: true,
      requireApproval: "always",
      help: false,
    });
  });

  test("rejects unknown approval modes", () => {
    expect(() => parseOpenAIMcpToolCliArgs(["--require-approval", "sometimes"])).toThrow(
      "--require-approval must be 'always' or 'never'"
    );
  });
});
