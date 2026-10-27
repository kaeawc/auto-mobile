import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startFakeAnthropicApi, type FakeAnthropicApi } from "./fixtures/fakeAnthropicApi";

/**
 * Real Claude Code against a stub built with AutoMobile's own dispatcher (#15591). It settles which
 * path a stdio Claude Code takes for the device question (legacy push or 2026-07-28 MRTR) and what
 * it answers, without touching a device. Advisory: it needs a Claude Code binary of at least
 * 2.1.311 (`AUTOMOBILE_CLAUDE_BIN`, else `claude` on PATH) and skips cleanly without one. The
 * binary is never downloaded here.
 */
const MIN_VERSION = [2, 1, 311] as const;
const RUN_TIMEOUT_MS = 90_000;
const STUB = path.join(import.meta.dir, "fixtures", "elicitationStubServer.ts");

function resolveBinary(): string | undefined {
  const configured = process.env.AUTOMOBILE_CLAUDE_BIN;
  const candidates = configured
    ? [configured]
    : (process.env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, "claude"));
  return candidates.find((candidate) => existsSync(candidate));
}

async function versionOf(binary: string): Promise<string | undefined> {
  const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  await new Promise((resolve) => child.once("close", resolve));
  return /\d+\.\d+\.\d+/.exec(out)?.[0];
}

function atLeast(version: string): boolean {
  const parts = version.split(".").map(Number);
  for (const [index, minimum] of MIN_VERSION.entries()) {
    const part = parts[index] ?? 0;
    if (part !== minimum) {
      return part > minimum;
    }
  }
  return true;
}

const binary = resolveBinary();
const version = binary ? await versionOf(binary) : undefined;
const runnable = binary !== undefined && version !== undefined && atLeast(version);
if (!runnable) {
  console.warn(
    `claudeCodeElicitation: skipped, no Claude Code >= ${MIN_VERSION.join(".")} ` +
      `(AUTOMOBILE_CLAUDE_BIN or PATH; found ${version ?? "none"})`,
  );
}

interface Observation {
  readonly lines: Array<Record<string, unknown>>;
  readonly toolResult: string | undefined;
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) {
    await step();
  }
});

async function runClaude(
  era: "legacy" | "modern",
  env: Record<string, string> = {},
): Promise<Observation> {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-elicitation-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "stub.log");
  writeFileSync(log, "");
  const api = await startFakeAnthropicApi("ask");
  cleanup.push(() => api.close());
  const mcpConfig = path.join(dir, "mcp.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        stub: {
          command: process.execPath,
          args: [STUB],
          env: { STUB_LOG: log, STUB_ERA: era, STUB_TIMEOUT_MS: "5000" },
        },
      },
    }),
  );
  const child = spawn(
    binary as string,
    [
      "-p",
      "call the ask tool",
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      "--dangerously-skip-permissions",
    ],
    {
      cwd: dir,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: path.join(dir, "home"),
        CLAUDE_CONFIG_DIR: path.join(dir, "config"),
        ANTHROPIC_BASE_URL: api.url,
        ANTHROPIC_API_KEY: "sk-ant-fake",
        // Headless Claude Code connects MCP servers late and defers their tools behind search.
        MCP_CONNECTION_NONBLOCKING: "0",
        ENABLE_TOOL_SEARCH: "false",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        ...env,
      },
    },
  );
  cleanup.push(() => void child.kill("SIGKILL"));
  await new Promise((resolve) => child.once("close", resolve));
  return observe(log, api);
}

function observe(log: string, api: FakeAnthropicApi): Observation {
  const lines = readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, toolResult: api.toolResultText() };
}

describe.skipIf(!runnable)("real Claude Code and the device question (#15591)", () => {
  test(
    "legacy server: headless Claude Code declares elicitation on initialize and cancels",
    async () => {
      const { lines, toolResult } = await runClaude("legacy");
      const call = lines.find((line) => line.kind === "call");
      expect(call?.legacyCapabilities).toHaveProperty("elicitation");
      const record = lines.find((line) => line.kind === "record");
      expect(record).toMatchObject({ era: "legacy", outcome: "cancel" });
      expect(["bare", "form"]).toContain(record?.declared as string);
      // Headless cancel is instant, so the call ends with the typed refusal and no stall.
      expect(toolResult).toContain("ambiguous_device_target");
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "modern-era server over stdio: records which handshake Claude Code used and never stalls",
    async () => {
      const { lines, toolResult } = await runClaude("modern");
      const call = lines.find((line) => line.kind === "call");
      const record = lines.find((line) => line.kind === "record");
      expect(record).toBeDefined();
      expect(toolResult).toContain("ambiguous_device_target");
      if (call?.envelope === null) {
        // Observed against 2.1.311: the stub never answers `server/discover`, so Claude Code treats
        // it as a legacy peer and declares elicitation on `initialize`, not in a request envelope.
        // The modern wrapper reads only the envelope, so it records not_offered.
        expect(call.legacyCapabilities).toHaveProperty("elicitation");
        expect(record).toMatchObject({ era: "modern", declared: "none", outcome: "not_offered" });
      } else {
        // Claude Code negotiated 2026-07-28: the question is handed back as input_required.
        expect(["asked", "accept", "decline", "cancel"]).toContain(record?.outcome as string);
      }
    },
    RUN_TIMEOUT_MS,
  );
});
