import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultTimer } from "../../src/utils/SystemTimer";
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

/** Opt-in only: a developer's own `claude` on PATH is never spawned by the integration lane. */
function resolveBinary(): string | undefined {
  const configured = process.env.AUTOMOBILE_CLAUDE_BIN;
  if (!configured) {
    return undefined;
  }
  try {
    accessSync(configured, constants.X_OK);
    return statSync(configured).isFile() ? configured : undefined;
  } catch {
    // A missing or non-executable binary is the skip case, not a failure.
    return undefined;
  }
}

const VERSION_PROBE_TIMEOUT_MS = 10_000;

async function versionOf(binary: string): Promise<string | undefined> {
  const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  const killer = defaultTimer.setTimeout(() => child.kill("SIGKILL"), VERSION_PROBE_TIMEOUT_MS);
  await new Promise((resolve) => {
    child.once("error", resolve);
    child.once("close", resolve);
  });
  defaultTimer.clearTimeout(killer);
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
      `(set AUTOMOBILE_CLAUDE_BIN; found ${version ?? "none"})`,
  );
}

interface Observation {
  readonly lines: Array<Record<string, unknown>>;
  readonly toolResult: string | undefined;
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  // Newest first: kill the child, then close the API, then remove the directory.
  for (const step of cleanup.splice(0).reverse()) {
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
  const errFd = openSync(path.join(dir, "claude.err"), "w");
  cleanup.push(() => closeSync(errFd));
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
      stdio: ["ignore", "ignore", errFd],
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
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ...env,
      },
    },
  );
  cleanup.push(() => void child.kill("SIGKILL"));
  const stop = defaultTimer.setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS - 5_000);
  const exit = await new Promise<string>((resolve) => {
    child.once("error", (error) => resolve(`spawn error: ${error.message}`));
    child.once("close", (code, signal) => resolve(`code=${code} signal=${signal}`));
  });
  defaultTimer.clearTimeout(stop);
  const observation = observe(log, api);
  if (observation.lines.every((line) => line.kind !== "record")) {
    // Nothing recorded means the run never reached the tool; keep Claude's own words for the log.
    console.warn(
      `claude ${era} run: ${exit}\n${readFileSync(path.join(dir, "claude.err"), "utf8")}`,
    );
  }
  return observation;
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
