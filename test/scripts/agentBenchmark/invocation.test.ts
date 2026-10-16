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
      "--append-system-prompt",
      "SYSTEM",
      "--allowedTools",
      "mcp__auto-mobile",
      "--disallowedTools",
      "Bash",
    ]);
  });

  test("the CLI model override wins over the suite model; extra args come last", () => {
    const configured = suite({
      model: "suite-model",
      maxBudgetUsd: 1.5,
      extraArgs: ["--effort", "low"],
    });
    const args = buildClaudeArgs(configured, "/c.json", "S", "cli-model");
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "cli-model",
    ]);
    expect(args).toContain("1.5");
    expect(args.slice(-2)).toEqual(["--effort", "low"]);
    expect(buildClaudeArgs(configured, "/c.json", "S")).toContain("suite-model");
  });

  test("empty tool lists drop their flags", () => {
    const args = buildClaudeArgs(suite({ allowedTools: [], disallowedTools: [] }), "/c.json", "S");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--disallowedTools");
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
  test("strips inherited AutoMobile state overrides but keeps shared device claims", () => {
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
