import { describe, expect, test } from "bun:test";
import { parseSuiteDefinition } from "../../../scripts/agent-benchmark/config";
import {
  buildClaudeArgs,
  buildMcpConfig,
  fillPlaceholders,
  isolatedServerEnv,
  providerIdentity,
  systemPromptFor,
  isRunShapingClaudeVariable,
} from "../../../scripts/agent-benchmark/invocation";
import { createHash } from "node:crypto";

const pathDigest = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 12);

const PATHS = {
  runtime: "/usr/bin/bun",
  serverEntry: "/repo/dist/src/index.js",
  auxSocketDir: "/tmp/amb-abc",
  dataDir: "/run/data",
  dbDir: "/run/db",
  logDir: "/run/logs",
};
const VALUES = { deviceSerial: "emulator-5554", packageName: "dev.example", runDirectory: "/run" };

function suite(claude: Record<string, unknown> = {}) {
  return parseSuiteDefinition(
    {
      name: "demo",
      platform: "android",
      prompt: "p.md",
      app: { packageName: "dev.example" },
      verify: { answerIncludes: ["DONE"], screenIncludes: ["Done"] },
      claude,
    },
    "demo.yml",
  );
}

describe("agent benchmark claude invocation", () => {
  test("isolates MCP config, streams JSON, and never carries the prompt in argv", () => {
    const args = buildClaudeArgs(suite(), "/run/mcp-config.json", "SYSTEM");
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--mcp-config",
      "/run/mcp-config.json",
      "--strict-mcp-config",
      "--setting-sources",
      "project,local",
      "--append-system-prompt",
      "SYSTEM",
      "--allowedTools",
      "mcp__auto-mobile",
      "--disallowedTools",
      "Bash",
    ]);
  });

  test("the CLI model override wins over the suite model", () => {
    const configured = suite({ model: "suite-model", maxBudgetUsd: 1.5 });
    const args = buildClaudeArgs(configured, "/c.json", "S", "cli-model");
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "cli-model",
    ]);
    expect(args).toContain("1.5");
    expect(buildClaudeArgs(configured, "/c.json", "S")).toContain("suite-model");
  });

  test("an empty allow list drops its flag; Bash is always denied", () => {
    const args = buildClaudeArgs(suite({ allowedTools: [], disallowedTools: [] }), "/c.json", "S");
    expect(args).not.toContain("--allowedTools");
    expect(args.slice(args.indexOf("--disallowedTools"))).toEqual(["--disallowedTools", "Bash"]);
    const extra = buildClaudeArgs(
      suite({ disallowedTools: ["mcp__auto-mobile__openLink"] }),
      "/c.json",
      "S",
    );
    expect(extra.slice(extra.indexOf("--disallowedTools"))).toEqual([
      "--disallowedTools",
      "Bash",
      "mcp__auto-mobile__openLink",
    ]);
  });

  test("the system prompt pins the device and appends filled suite text", () => {
    expect(systemPromptFor(suite(), VALUES)).toBe(
      "Use only the Android device with serial emulator-5554. The app under test is dev.example. " +
        "Interact with the device only through the auto-mobile MCP tools.",
    );
    const extra = systemPromptFor(
      suite({ appendSystemPrompt: "Device {deviceSerial} in {runDirectory}." }),
      VALUES,
    );
    expect(extra.endsWith("\n\nDevice emulator-5554 in /run.")).toBe(true);
    expect(fillPlaceholders("{packageName} {packageName}", VALUES)).toBe("dev.example dev.example");
  });

  test("the MCP server env carries only shared claim roots from the inherited env", () => {
    const config = buildMcpConfig(PATHS, {
      PATH: "/bin",
      AUTOMOBILE_ADB_SERVER_COORDINATION_DIR: "/shared/claims",
      AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR: "/shared/legacy",
      AUTOMOBILE_DB_PATH: "/resident.db",
      ADB_SERVER_SOCKET: "tcp:remote:5037",
      ANDROID_ADB_SERVER_ADDRESS: "remote",
      ANDROID_ADB_SERVER_PORT: "5038",
      ANDROID_HOME: "/sdk",
    }) as { mcpServers: Record<string, { env: Record<string, string> }> };
    const env = config.mcpServers["auto-mobile"].env;
    expect(env.AUTOMOBILE_ADB_SERVER_COORDINATION_DIR).toBe("/shared/claims");
    expect(env.AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR).toBe("/shared/legacy");
    expect(env.ADB_SERVER_SOCKET).toBe("tcp:remote:5037");
    expect(env.ANDROID_ADB_SERVER_ADDRESS).toBe("remote");
    expect(env.ANDROID_ADB_SERVER_PORT).toBe("5038");
    expect(env.ANDROID_HOME).toBe("/sdk");
    expect(env.PATH).toBeUndefined();
    expect(env.AUTOMOBILE_DB_PATH).toBeUndefined();
    expect(env.AUTOMOBILE_DB_DIR).toBe("/run/db");
    expect(env.AUTOMOBILE_DATA_DIR).toBe("/run/data");
  });

  test("the MCP server runs against a private daemon with fresh state", () => {
    expect(buildMcpConfig(PATHS)).toEqual({
      mcpServers: {
        "auto-mobile": {
          type: "stdio",
          command: "/usr/bin/bun",
          args: ["/repo/dist/src/index.js"],
          env: {
            AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/amb-abc",
            AUTOMOBILE_HARNESS_PRIVATE_DAEMON: "1",
            AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS: "5000",
            AUTOMOBILE_DATA_DIR: "/run/data",
            AUTOMOBILE_DB_DIR: "/run/db",
            AUTOMOBILE_LOG_DIR: "/run/logs",
          },
        },
      },
    });
  });
});

describe("agent benchmark isolated server environment", () => {
  test("strips every inherited AutoMobile variable but keeps shared device claims", () => {
    const env = isolatedServerEnv(
      {
        PATH: "/bin",
        HOME: "/home/me",
        UNSET: undefined,
        // Inherited from a bun test parent, it would arm the server's test-only guards.
        NODE_ENV: "test",
        AUTOMOBILE_DB_PATH: "/resident.db",
        AUTO_MOBILE_DB_PATH: "/legacy.db",
        AUTOMOBILE_DATA_DIR: "/resident-data",
        AUTOMOBILE_DAEMON_SOCKET_PATH: "/tmp/resident.sock",
        AUTOMOBILE_DAEMON_LOCK_FILE_PATH: "/tmp/resident.lock",
        AUTOMOBILE_DISABLED_TOOLS: "observe",
        AUTOMOBILE_ENABLED_TOOLS: "tapOn",
        AUTO_MOBILE_TOOLSET: "legacy",
        AUTOMOBILE_ADB_SERVER_COORDINATION_DIR: "/shared/claims",
      },
      PATHS,
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/me",
      AUTOMOBILE_ADB_SERVER_COORDINATION_DIR: "/shared/claims",
      AUTOMOBILE_AUX_SOCKET_DIR: "/tmp/amb-abc",
      AUTOMOBILE_HARNESS_PRIVATE_DAEMON: "1",
      AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS: "5000",
      AUTOMOBILE_DATA_DIR: "/run/data",
      AUTOMOBILE_DB_DIR: "/run/db",
      AUTOMOBILE_LOG_DIR: "/run/logs",
    });
  });
});

describe("agent benchmark provider identity", () => {
  test("records provider, base URL host, region, and routing without secrets", () => {
    const identity = providerIdentity({
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_BASE_URL: "https://user:secret@proxy.example.com/v1?key=abc",
      AWS_REGION: "us-west-2",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "routed-sonnet",
      ANTHROPIC_API_KEY: "sk-secret",
      AWS_SECRET_ACCESS_KEY: "secret",
    });
    expect(identity).toBe(
      [
        `ANTHROPIC_BASE_URL=https://proxy.example.com/sha256:${pathDigest("/v1")}`,
        "ANTHROPIC_DEFAULT_SONNET_MODEL=routed-sonnet",
        "AWS_REGION=us-west-2",
        "CLAUDE_CODE_USE_BEDROCK=1",
      ].join("\n"),
    );
    expect(identity).not.toContain("secret");
    expect(providerIdentity({})).toBe("");
    // Every Claude/API/MCP/Bash timeout or watchdog override is run-shaping.
    for (const key of [
      "API_TIMEOUT_MS",
      "API_FORCE_IDLE_TIMEOUT",
      "CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS",
      "CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS",
      "CLAUDE_CODE_GLOB_TIMEOUT_SECONDS",
    ]) {
      expect({ key, scrubbed: isRunShapingClaudeVariable(key) }).toEqual({ key, scrubbed: true });
    }
    expect(isRunShapingClaudeVariable("ANTHROPIC_API_KEY")).toBe(false);
    expect(isRunShapingClaudeVariable("CLAUDE_CODE_ATTRIBUTION_HEADER")).toBe(true);
    expect(isRunShapingClaudeVariable("CLAUDE_AUTO_BACKGROUND_TASKS")).toBe(true);
    expect(isRunShapingClaudeVariable("CLAUDE_CODE_EXTRA_BODY")).toBe(true);
    // The allowlist toggle would hide PATH (and the fingerprinted adb) from the server.
    expect(isRunShapingClaudeVariable("CLAUDE_CODE_MCP_ALLOWLIST_ENV")).toBe(true);
    expect(isRunShapingClaudeVariable("ANTHROPIC_BETAS")).toBe(true);
    expect(isRunShapingClaudeVariable("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS")).toBe(true);
    expect(isRunShapingClaudeVariable("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")).toBe(true);
    // Every provider endpoint override and the adb endpoint are part of the identity.
    expect(
      providerIdentity({
        ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example",
        ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "https://mantle.example",
        ANTHROPIC_AWS_BASE_URL: "https://aws.example",
        ADB_SERVER_SOCKET: "tcp:10.0.0.5:5037",
        ANDROID_ADB_SERVER_PORT: "5038",
      }),
    ).toBe(
      [
        "ADB_SERVER_SOCKET=tcp:10.0.0.5:5037",
        "ANDROID_ADB_SERVER_PORT=5038",
        "ANTHROPIC_AWS_BASE_URL=https://aws.example",
        "ANTHROPIC_BEDROCK_MANTLE_BASE_URL=https://mantle.example",
        "ANTHROPIC_FOUNDRY_BASE_URL=https://foundry.example",
      ].join("\n"),
    );
    // Gateway routes on one host differ by path; a trailing slash is the same route.
    const route = (url: string) => providerIdentity({ ANTHROPIC_BASE_URL: url });
    expect(route("https://gw:4000")).toBe("ANTHROPIC_BASE_URL=https://gw:4000");
    expect(route("https://gw:4000/")).toBe("ANTHROPIC_BASE_URL=https://gw:4000");
    expect(route("https://gw:4000/anthropic")).not.toBe(route("https://gw:4000"));
    expect(route("https://gw:4000/anthropic/")).toBe(route("https://gw:4000/anthropic"));
    expect(route("https://gw:4000/anthropic")).not.toContain("anthropic");
    // http and https to one gateway are different transports.
    expect(route("http://gw:4000/anthropic")).not.toBe(route("https://gw:4000/anthropic"));
    // Provider-specific region routing is recorded.
    expect(
      providerIdentity({
        ANTHROPIC_BEDROCK_REGION_PREFIX: "eu",
        ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: "us-east-2",
        VERTEX_REGION_CLAUDE_HAIKU: "europe-west1",
        ANTHROPIC_BEDROCK_SERVICE_TIER: "flex",
        ANTHROPIC_FOUNDRY_RESOURCE: "my-resource",
      }),
    ).toBe(
      [
        "ANTHROPIC_BEDROCK_REGION_PREFIX=eu",
        "ANTHROPIC_BEDROCK_SERVICE_TIER=flex",
        "ANTHROPIC_FOUNDRY_RESOURCE=my-resource",
        "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION=us-east-2",
        "VERTEX_REGION_CLAUDE_HAIKU=europe-west1",
      ].join("\n"),
    );
    expect(
      providerIdentity({ CLAUDE_CODE_USE_MANTLE: "1", CLAUDE_CODE_USE_ANTHROPIC_AWS: "1" }),
    ).toBe(["CLAUDE_CODE_USE_ANTHROPIC_AWS=1", "CLAUDE_CODE_USE_MANTLE=1"].join("\n"));
    // Proxy routing is recorded by host and bypass list, never with its credentials.
    const proxied = providerIdentity({
      HTTPS_PROXY: "http://user:pass@proxy.corp:3128",
      no_proxy: "localhost,127.0.0.1",
    });
    expect(proxied).toBe(
      ["HTTPS_PROXY=http://proxy.corp:3128", "no_proxy=localhost,127.0.0.1"].join("\n"),
    );
    expect(proxied).not.toContain("pass");
    expect(providerIdentity({ ANTHROPIC_BASE_URL: "not a url" })).toBe(
      "ANTHROPIC_BASE_URL=(unparseable)",
    );
  });
});
