#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { startFakeAnthropicApi } from "./fakeAnthropicApi";
import { conformanceProblems, observeElicitation, type StubLogLine } from "./observation";

// Drives a real Claude Code binary, headless, against a stub MCP server and a fake local API to
// record which elicitation path a stdio client takes (#15591, #13945). Everything runs in a
// throwaway HOME and CLAUDE_CONFIG_DIR with a dummy API key, so the real ~/.claude is never read.
// Usage: bun scripts/conformance/claude-elicitation/run.ts [claude binary] (default: `claude`).
const TOOL = "mcp__stub__pick";
const claudeBinary = process.argv[2] ?? process.env.CLAUDE_CODE_BIN ?? "claude";
const TIMEOUT_MS = 120_000;

async function main(): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), "claude-elicitation-"));
  const logPath = join(root, "stub.jsonl");
  const api = startFakeAnthropicApi(TOOL);
  try {
    writeFileSync(
      join(root, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          stub: {
            command: process.execPath,
            args: [join(import.meta.dir, "stubMcpServer.ts"), logPath],
          },
        },
      }),
    );
    const child = Bun.spawn(
      [
        claudeBinary,
        "-p",
        "use the pick tool",
        "--mcp-config",
        join(root, "mcp.json"),
        "--strict-mcp-config",
        "--allowedTools",
        TOOL,
        "--output-format",
        "json",
      ],
      {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: join(root, "home"),
          CLAUDE_CONFIG_DIR: join(root, "config"),
          ANTHROPIC_BASE_URL: api.url,
          ANTHROPIC_API_KEY: "sk-ant-conformance-dummy",
          // In -p mode MCP servers otherwise connect in the background and the tool list can be empty.
          MCP_CONNECTION_NONBLOCKING: "0",
          ENABLE_TOOL_SEARCH: "false",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
        timeout: TIMEOUT_MS,
      },
    );
    const exitCode = await child.exited;
    const lines = existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as StubLogLine)
      : [];
    const observation = observeElicitation(lines, CLIENT_CAPABILITIES_META_KEY);
    const problems = conformanceProblems(observation);
    console.log(JSON.stringify({ exitCode, observation, problems }, null, 2));
    return exitCode === 0 && problems.length === 0 ? 0 : 1;
  } finally {
    api.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

process.exit(await main());
