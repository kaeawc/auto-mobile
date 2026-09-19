#!/usr/bin/env bun
/**
 * mcp-drive — a general-purpose driver for the AutoMobile MCP server over ONE
 * persistent stdio connection.
 *
 * Why this exists: ad-hoc device driving (dogfood loops, manual-test iterations,
 * reproducing a bug) previously meant either the `--cli` path — a fresh process
 * per call whose device session dies on the 10s heartbeat (issue #6870) — or a
 * hand-rolled JSON-RPC loop that is easy to get subtly wrong (an undrained child
 * stderr pipe keeps the parent alive forever; a non-unref'd timer adds a tail;
 * truncated output; no build-mismatch handling). This script keeps a single MCP
 * session open for the whole plan and reuses the official
 * `@modelcontextprotocol/sdk` transport, exactly as `scripts/live-device-acceptance.ts`
 * does, so the framing/stderr/timeout details are handled by the SDK rather than
 * by hand.
 *
 * Usage:
 *   bun scripts/mcp-drive.ts <tool> [--key value ...]        # one tool call
 *   bun scripts/mcp-drive.ts --plan plan.json                # array of {tool,args}
 *
 * Options:
 *   --server <path>    entry script to spawn (default: this checkout's dist/src/index.js)
 *   --session <uuid>   reuse an existing device session instead of minting one
 *   --enable a,b,c     enableTools[] merged into the first session-minting call
 *   --json             print the full tool envelope as JSON (default: compact payload)
 *   --quiet            print only tool messages / errors
 *
 * A session minted by getAndroid/getApple/provisionDevice is captured and
 * injected as `sessionUuid` into every later call automatically. The process
 * exits non-zero if any tool call reports an error or isError (so scripts gate
 * on it rather than false-greening, cf. #6017), and prints a single actionable
 * hint — never a retry storm — when it hits a daemon/client build mismatch.
 */
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readToolEnvelopePayload } from "../src/server/toolEnvelopePayload";

export interface DriveStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface DriveOptions {
  serverPath?: string;
  session?: string;
  enable?: string[];
  json: boolean;
  quiet: boolean;
  steps: DriveStep[];
}

/** Tools that mint their own device session; sessionUuid must NOT be injected. */
export const SESSION_MINTING_TOOLS = new Set(["getAndroid", "getApple", "provisionDevice"]);

export function isSessionMintingTool(name: string): boolean {
  return SESSION_MINTING_TOOLS.has(name);
}

/**
 * Coerce a `--key value` string the way the built-in `--cli` does: JSON when it
 * parses (objects, arrays, numbers, booleans), otherwise the raw string, so
 * `--text 12345` stays the string "12345" only when it is not valid JSON — matching
 * caller expectations that `--selector '{"text":"x"}'` and `--index 0` both work.
 */
export function coerceValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Pull the session UUID a minting tool returned, if present. */
export function sessionUuidFromPayload(payload: unknown): string | undefined {
  if (payload && typeof payload === "object") {
    const value = (payload as Record<string, unknown>).sessionUuid;
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Inject the active session into a step unless it mints its own session or the
 * caller already set one explicitly. Returns a new step; never mutates input.
 */
export function applySession(step: DriveStep, session: string | undefined): DriveStep {
  if (!session || isSessionMintingTool(step.tool) || "sessionUuid" in step.args) {
    return step;
  }
  return { tool: step.tool, args: { ...step.args, sessionUuid: session } };
}

/**
 * Recognize a daemon/client build-mismatch error and turn it into one actionable
 * line instead of letting a caller loop on the cooldown retry. Returns undefined
 * for unrelated errors.
 */
export function buildMismatchHint(errorText: string | undefined): string | undefined {
  if (!errorText || !/build mismatch/i.test(errorText)) {
    return undefined;
  }
  return (
    "daemon/client build mismatch: the running daemon was started from a different " +
    "build than --server. Restart the daemon from the build you want to drive " +
    "(e.g. `bun <server> --daemon restart`) or point --server at the daemon's build, " +
    "then re-run. Not retrying."
  );
}

/** The subset of the MCP client this driver needs; faked in tests. */
export interface DriveClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface DriveDeps {
  createClient(serverPath: string): Promise<DriveClient>;
  log(message: string): void;
  /** Default entry script when --server is omitted. */
  defaultServerPath(): string;
}

export interface DriveStepResult {
  tool: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  errorText?: string;
  mismatchHint?: string;
}

export interface DriveResult {
  ok: boolean;
  session?: string;
  results: DriveStepResult[];
}

/** Extract `{payload, errorText}` from an MCP tool envelope. */
function readEnvelope(envelope: unknown): {
  payload?: Record<string, unknown>;
  errorText?: string;
} {
  const view = readToolEnvelopePayload(envelope);
  const payload = view?.payload;
  const isError = Boolean((envelope as { isError?: boolean } | undefined)?.isError);
  let errorText: string | undefined;
  if (payload && typeof payload.error === "string") {
    errorText = payload.error;
  } else if (payload && payload.error && typeof payload.error === "object") {
    errorText = JSON.stringify(payload.error);
  } else if (isError) {
    errorText = view?.textPart?.text ?? "tool reported isError";
  }
  return { payload, errorText };
}

/**
 * Run a plan over one persistent MCP session. Pure orchestration: all I/O is via
 * `deps`, so tests drive it with a fake client and assert session-injection,
 * exit semantics, and mismatch handling without spawning a process.
 */
export async function runDrive(options: DriveOptions, deps: DriveDeps): Promise<DriveResult> {
  const serverPath = options.serverPath ?? deps.defaultServerPath();
  const client = await deps.createClient(serverPath);
  const results: DriveStepResult[] = [];
  let session = options.session;
  let firstMint = true;
  let ok = true;
  try {
    for (const rawStep of options.steps) {
      let step = applySession(rawStep, session);
      if (
        isSessionMintingTool(step.tool) &&
        firstMint &&
        options.enable &&
        options.enable.length > 0
      ) {
        firstMint = false;
        const existing = Array.isArray(step.args.enableTools)
          ? (step.args.enableTools as unknown[])
          : [];
        step = {
          tool: step.tool,
          args: { ...step.args, enableTools: [...existing, ...options.enable] },
        };
      }
      const envelope = await client.callTool(step.tool, step.args);
      const { payload, errorText } = readEnvelope(envelope);
      const mintedSession = sessionUuidFromPayload(payload);
      if (isSessionMintingTool(step.tool) && mintedSession) {
        session = mintedSession;
      }
      const hint = buildMismatchHint(errorText);
      const stepOk = !errorText;
      results.push({ tool: step.tool, ok: stepOk, payload, errorText, mismatchHint: hint });
      if (!stepOk) {
        ok = false;
        deps.log(`### ${step.tool} ERROR: ${errorText}`);
        if (hint) {
          deps.log(hint);
          break; // a mismatch will not fix itself across the rest of the plan
        }
        continue;
      }
      const message =
        payload && typeof payload.message === "string" ? payload.message : "(no message)";
      deps.log(`### ${step.tool}: ${message}`);
      if (options.json) {
        deps.log(JSON.stringify(envelope, null, 2));
      }
    }
  } finally {
    await client.close();
  }
  return { ok, session, results };
}

/** Parse argv (excluding the `bun script.ts` prefix) into DriveOptions. */
export function parseDriveArgs(argv: string[], readPlan: (path: string) => string): DriveOptions {
  const options: DriveOptions = { json: false, quiet: false, steps: [] };
  let planPath: string | undefined;
  let tool: string | undefined;
  const args: Record<string, unknown> = {};
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === "--json") {
      options.json = true;
      i += 1;
    } else if (token === "--quiet") {
      options.quiet = true;
      i += 1;
    } else if (token === "--plan") {
      planPath = argv[++i];
      i += 1;
    } else if (token === "--server") {
      options.serverPath = resolve(argv[++i] ?? "");
      i += 1;
    } else if (token === "--session") {
      options.session = argv[++i];
      i += 1;
    } else if (token === "--enable") {
      options.enable = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
    } else if (token.startsWith("--")) {
      // A tool parameter: --key value (value coerced JSON-if-possible).
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true; // bare flag
        i += 1;
      } else {
        args[key] = coerceValue(next);
        i += 2;
      }
    } else if (!tool) {
      tool = token;
      i += 1;
    } else {
      throw new Error(
        `Unexpected positional argument "${token}" (only one tool name is allowed; use --plan for many).`,
      );
    }
  }

  if (planPath) {
    if (tool) {
      throw new Error("Pass either a <tool> or --plan, not both.");
    }
    const parsed = JSON.parse(readPlan(planPath)) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("--plan file must contain a JSON array of {tool, args} steps.");
    }
    options.steps = parsed.map((entry, index) => {
      const step = entry as Partial<DriveStep>;
      if (!step || typeof step.tool !== "string") {
        throw new Error(`--plan step ${index} is missing a string "tool" field.`);
      }
      return { tool: step.tool, args: (step.args as Record<string, unknown>) ?? {} };
    });
  } else if (tool) {
    options.steps = [{ tool, args }];
  } else {
    throw new Error("Provide a <tool> name or --plan <file>.");
  }
  return options;
}

async function createSdkClient(serverPath: string): Promise<DriveClient> {
  const client = new Client({ name: "mcp-drive", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    stderr: "inherit",
    env: { ...process.env },
  });
  await client.connect(transport);
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    close: () => client.close(),
  };
}

function defaultServerPath(): string {
  return resolve(new URL("../dist/src/index.js", import.meta.url).pathname);
}

async function main(): Promise<void> {
  const { readFileSync } = await import("node:fs");
  let options: DriveOptions;
  try {
    options = parseDriveArgs(process.argv.slice(2), (p) => readFileSync(p, "utf8"));
  } catch (error) {
    console.error(`mcp-drive: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  const result = await runDrive(options, {
    createClient: createSdkClient,
    defaultServerPath,
    log: (message) => {
      if (!options.quiet || message.includes("ERROR") || message.includes("mismatch")) {
        console.log(message);
      }
    },
  });
  if (result.session) {
    console.log(`session: ${result.session}`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.main) {
  void main();
}
