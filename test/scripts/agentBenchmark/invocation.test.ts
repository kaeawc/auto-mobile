import { describe, expect, test } from "bun:test";
import { parseSuiteDefinition } from "../../../scripts/agent-benchmark/config";
import {
  buildClaudeArgs,
  buildMcpConfig,
  fillPlaceholders,
  isolatedServerEnv,
  systemPromptFor,
} from "../../../scripts/agent-benchmark/invocation";

const PATHS = {
  runtime: "/usr/bin/bun",
  serverEntry: "/repo/dist/src/index.js",
  auxSocketDir: "/tmp/amb-abc",
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
      AUTOMOBILE_DB_DIR: "/run/db",
      AUTOMOBILE_LOG_DIR: "/run/logs",
    });
  });
});
