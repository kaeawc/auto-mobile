#!/usr/bin/env bun
/** Persistent manual-test MCP session. Serve remains the stdio proxy's parent and execution
 * owner. Requests are atomically published in in/, responses in out/; no daemon flags are
 * passed to the proxy. This driver never directly signals a process or deletes a directory/device. */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  MANAGED_SLOT_CONFIG_FLAG,
  MANAGED_SLOTS_EXPERIMENTAL_CAPABILITY,
  parseManagedSlotConfigSource,
} from "../../src/models/managedSlotConfig";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { defaultIdGenerator, type IdGenerator } from "../../src/utils/IdGenerator";
import { isProcessRunning } from "../../src/utils/processLiveness";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";
import { ensureSecureDirectorySync } from "../../src/utils/tempDir";
import { deviceStartGuardRefusal } from "./deviceStartGuard";
import { privateHarnessEnvRefusal } from "./harnessEnv";
import { extraEnvRefusal, privateClientEnvironment, type HostDefaults } from "./privateDaemonEnv";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export interface ProxySessionCommand {
  op: "up" | "serve" | "call" | "read" | "tools" | "resources" | "subscribe" | "status" | "close";
  dir: string;
  config?: string;
  env: Record<string, string>;
  initTimeoutMs: number;
  timeoutMs: number;
  full: boolean;
  allowSelector: boolean;
  tool?: string;
  json?: string;
  uri?: string;
}
export function parseProxySessionArgs(argv: string[]): ProxySessionCommand | { error: string } {
  const [op, ...args] = argv;
  if (
    !["up", "serve", "call", "read", "tools", "resources", "subscribe", "status", "close"].includes(
      op,
    )
  ) {
    return {
      error:
        "Usage: proxy-session <up|serve|call|read|tools|resources|subscribe|status|close> --dir D ...",
    };
  }
  const command: ProxySessionCommand = {
    op: op as ProxySessionCommand["op"],
    dir: "",
    env: {},
    initTimeoutMs: DEFAULT_TIMEOUT_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    full: false,
    allowSelector: false,
  };
  const positional: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag.startsWith("-")) {
      positional.push(flag);
      continue;
    }
    if (flag === "--full" && !["up", "serve", "status"].includes(op)) {
      command.full = true;
      continue;
    }
    if (flag === "--allow-selector" && op === "call") {
      command.allowSelector = true;
      continue;
    }
    const allowed = [
      "--dir",
      ...(["up", "serve"].includes(op) ? ["--config", "--env", "--init-timeout-ms"] : []),
      ...(op === "call" ? ["--timeout-ms"] : []),
    ];
    if (!allowed.includes(flag)) {
      return { error: `Unknown flag ${flag} for ${op}.` };
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) {
      return { error: `Missing value for ${flag}.` };
    }
    if (seen.has(flag) && flag !== "--env") {
      return { error: `Duplicate flag ${flag}.` };
    }
    seen.add(flag);
    if (flag === "--dir") {
      command.dir = resolve(value);
    } else if (flag === "--config") {
      command.config = value;
    } else if (flag === "--env") {
      const eq = value.indexOf("=");
      if (eq < 1) {
        return { error: "--env requires K=V." };
      }
      command.env[value.slice(0, eq)] = value.slice(eq + 1);
    } else {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n <= 0 || n > 2_147_483_647) {
        return { error: `${flag} must be a positive timer-safe integer.` };
      }
      if (flag === "--timeout-ms") {
        command.timeoutMs = n;
      } else {
        command.initTimeoutMs = n;
      }
    }
  }
  if (!command.dir) {
    return { error: "--dir is required." };
  }
  const count = op === "call" ? [1, 2] : ["read", "subscribe"].includes(op) ? [1] : [0];
  if (!count.includes(positional.length)) {
    return { error: `${op} has missing or excess positional arguments.` };
  }
  if (op === "call") {
    [command.tool, command.json] = positional;
  }
  if (op === "read" || op === "subscribe") {
    command.uri = positional[0];
  }
  const error = extraEnvRefusal(command.env);
  return error ? { error } : command;
}
const requestSchema = z
  .object({
    id: z.string().min(1),
    op: z.enum(["call", "read", "tools", "resources", "subscribe", "close"]),
    tool: z.string().min(1).optional(),
    args: z.record(z.unknown()).optional(),
    uri: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
    allowSelector: z.boolean().optional(),
  })
  .superRefine((request, ctx) => {
    if (request.op === "call" && !request.tool) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "call requires a tool" });
    }
    if (["read", "subscribe"].includes(request.op) && !request.uri) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "resource request requires a uri" });
    }
  });
type Request = z.infer<typeof requestSchema>;
export interface ProxySessionClient {
  connect(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
  pid(): number | undefined;
  capabilities(): Record<string, unknown> | undefined;
  serverInfo(): unknown;
  callTool(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
  readResource(uri: string, timeoutMs: number): Promise<unknown>;
  listTools(timeoutMs: number): Promise<unknown>;
  listResources(timeoutMs: number): Promise<unknown>;
  listResourceTemplates(timeoutMs: number): Promise<unknown>;
  subscribeResource(uri: string, timeoutMs: number): Promise<unknown>;
}
export interface ProxySessionDeps {
  env: Record<string, string | undefined>;
  host: HostDefaults;
  pid: number;
  timer: Timer;
  ids: IdGenerator;
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  writeJson(path: string, value: unknown): void;
  appendFile(path: string, text: string): void;
  mkdir(path: string): void;
  listFiles(path: string): string[];
  isPidAlive(pid: number): boolean;
  createClient(options: {
    server: string;
    config?: string;
    env: Record<string, string>;
    stderrPath: string;
    onClose(): void;
    onNotification(notification: unknown): void;
  }): ProxySessionClient;
  spawnServe(command: ProxySessionCommand): number;
  log(text: string): void;
  flush(text: string): Promise<void>;
  exit(code: number): void;
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function errorJson(error: unknown): Record<string, unknown> {
  const fields = record(error);
  return {
    name: error instanceof Error ? error.name : undefined,
    message: errorMessage(error),
    code: fields?.code,
    data: fields?.data,
  };
}
function readJson(path: string, deps: ProxySessionDeps): Record<string, unknown> | undefined {
  return deps.exists(path) ? record(JSON.parse(deps.readFile(path))) : undefined;
}
function privateEnv(command: ProxySessionCommand, deps: ProxySessionDeps): Record<string, string> {
  return privateClientEnvironment(deps.env, command.env);
}
function startupRefusal(command: ProxySessionCommand, deps: ProxySessionDeps): string | undefined {
  return (
    extraEnvRefusal(command.env) ?? privateHarnessEnvRefusal(privateEnv(command, deps), deps.host)
  );
}
function validateConfig(command: ProxySessionCommand, deps: ProxySessionDeps): void {
  if (command.config !== undefined) {
    parseManagedSlotConfigSource(command.config, deps.readFile);
  }
}
export function renderResponse(response: Record<string, unknown>, full: boolean): string {
  if (full) {
    return JSON.stringify(response, null, 2);
  }
  const result = record(response.result);
  const content = Array.isArray(result?.content) ? result.content.map(record) : [];
  const contents = Array.isArray(result?.contents) ? result.contents.map(record) : [];
  const text = content.find((part) => part?.type === "text")?.text ?? contents[0]?.text;
  let payload: unknown = result ?? response.error;
  if (result?.structuredContent !== undefined) {
    payload = result.structuredContent;
  } else if (typeof text === "string") {
    try {
      payload = JSON.parse(text);
    } catch {
      // Plain text is an expected MCP payload, not a failed request.
      payload = text;
    }
  }
  return JSON.stringify(
    { ok: response.ok, ms: response.ms, isError: result?.isError, payload },
    null,
    2,
  );
}
export async function runServe(
  command: ProxySessionCommand,
  deps: ProxySessionDeps,
): Promise<number> {
  const refusal = startupRefusal(command, deps);
  if (refusal) {
    deps.log(refusal);
    return 2;
  }
  validateConfig(command, deps);
  const dir = command.dir;
  for (const name of ["init.json", "driver.pid", "proxy.pid", "closed.json"]) {
    if (deps.exists(join(dir, name))) {
      deps.log("Use a NEW --dir per proxy launch.");
      return 2;
    }
  }
  deps.mkdir(join(dir, "in"));
  deps.mkdir(join(dir, "out"));
  deps.writeFile(join(dir, "driver.pid"), `${deps.pid}\n`);
  // Ensure the evidence files exist even when the session emits no notifications/stderr.
  for (const name of ["events.jsonl", "notifications.jsonl", "proxy.stderr.log"]) {
    deps.appendFile(join(dir, name), "");
  }
  const event = (kind: string, data: Record<string, unknown> = {}): void =>
    deps.appendFile(
      join(dir, "events.jsonl"),
      `${JSON.stringify({ at: new Date(deps.timer.now()).toISOString(), kind, ...data })}\n`,
    );
  let closing = false;
  let finished: number | undefined;
  const finish = async (reason: string, code: number): Promise<number> => {
    if (finished !== undefined) {
      return finished;
    }
    finished = code;
    deps.writeJson(join(dir, "closed.json"), {
      at: new Date(deps.timer.now()).toISOString(),
      reason,
    });
    event("closed", { reason });
    await deps.flush("");
    deps.exit(code);
    return code;
  };
  const env = privateEnv(command, deps);
  const client = deps.createClient({
    server: env.MT_SERVER,
    config: command.config,
    env,
    stderrPath: join(dir, "proxy.stderr.log"),
    onClose: () => {
      if (!closing) {
        void finish("proxy_exited_or_transport_closed", 3);
      }
    },
    onNotification: (notification) =>
      deps.appendFile(
        join(dir, "notifications.jsonl"),
        `${JSON.stringify({ at: new Date(deps.timer.now()).toISOString(), notification })}\n`,
      ),
  });
  const startedAt = deps.timer.now();
  event("spawn", { config: command.config ?? null });
  const savePid = (): void => {
    const pid = client.pid();
    if (pid) {
      deps.writeFile(join(dir, "proxy.pid"), `${pid}\n`);
    }
  };
  const pidTimer = deps.timer.setInterval(savePid, 20);
  try {
    await client.connect(command.initTimeoutMs);
  } catch (error) {
    deps.log(`MCP initialize failed: ${errorMessage(error)}`);
    deps.writeJson(join(dir, "init.json"), {
      ok: false,
      initializeMs: deps.timer.now() - startedAt,
      error: errorJson(error),
    });
    closing = true;
    try {
      await client.close();
    } catch (closeError) {
      deps.log(`MCP cleanup failed: ${errorMessage(closeError)}`);
    }
    return await finish("initialize_failed", 4);
  } finally {
    deps.timer.clearInterval(pidTimer);
  }
  try {
    savePid();
    if (finished !== undefined) {
      return finished;
    }
    const capabilities = client.capabilities();
    deps.writeJson(join(dir, "init.json"), {
      ok: true,
      initializeMs: deps.timer.now() - startedAt,
      startedAt: new Date(startedAt).toISOString(),
      proxyPid: client.pid(),
      driverPid: deps.pid,
      config: command.config ?? null,
      serverInfo: client.serverInfo(),
      capabilities,
      managedSlots:
        record(capabilities?.experimental)?.[MANAGED_SLOTS_EXPERIMENTAL_CAPABILITY] ?? null,
    });
    event("initialized");
    const handle = async (request: Request): Promise<unknown> => {
      const timeout = request.timeoutMs ?? command.timeoutMs;
      switch (request.op) {
        case "call": {
          const error = deviceStartGuardRefusal(request.tool ?? "", request.args, {
            allowSelector: request.allowSelector === true,
          });
          if (error) {
            throw new Error(error);
          }
          return client.callTool(request.tool!, request.args ?? {}, timeout);
        }
        case "read":
          return client.readResource(request.uri!, timeout);
        case "tools":
          return client.listTools(timeout);
        case "resources": {
          const [resources, templates] = await Promise.all([
            client.listResources(timeout),
            client.listResourceTemplates(timeout).catch((error: unknown) => {
              deps.log(`Resource templates unavailable: ${errorMessage(error)}`);
              return { error: errorJson(error) };
            }),
          ]);
          return { resources, templates };
        }
        case "subscribe":
          return client.subscribeResource(request.uri!, timeout);
        default:
          throw new Error(`Unknown request op ${request.op}.`);
      }
    };
    const seen = new Set<string>();
    const pending = new Set<Promise<void>>();
    while (finished === undefined) {
      for (const file of deps
        .listFiles(join(dir, "in"))
        .filter((file) => file.endsWith(".json") && !seen.has(file))
        .sort()) {
        seen.add(file);
        const request = requestSchema.parse(readJson(join(dir, "in", file), deps));
        const t0 = deps.timer.now();
        if (request.op === "close") {
          closing = true;
          event("close_requested");
          try {
            await client.close();
          } catch (error) {
            deps.log(`MCP close failed: ${errorMessage(error)}`);
            deps.writeJson(join(dir, "out", file), {
              id: request.id,
              op: "close",
              ok: false,
              error: errorJson(error),
            });
            return finish("close_failed", 1);
          }
          await Promise.all(pending);
          deps.writeJson(join(dir, "out", file), {
            id: request.id,
            op: "close",
            ok: true,
            ms: deps.timer.now() - t0,
          });
          return finish("closed_by_request", 0);
        }
        event("request", { id: request.id, op: request.op, tool: request.tool, uri: request.uri });
        const respond = (body: Record<string, unknown>): void => {
          deps.writeJson(join(dir, "out", file), {
            id: request.id,
            op: request.op,
            tool: request.tool,
            ms: deps.timer.now() - t0,
            startedAt: new Date(t0).toISOString(),
            endedAt: new Date(deps.timer.now()).toISOString(),
            ...body,
          });
          event("response", { id: request.id, ok: body.ok });
        };
        // Track, but do not await: a long call must not block another request.
        const task = handle(request).then(
          (result) => respond({ ok: record(result)?.isError !== true, result }),
          (error: unknown) => {
            deps.log(`MCP request failed: ${errorMessage(error)}`);
            respond({ ok: false, error: errorJson(error) });
          },
        );
        pending.add(task);
        void task.then(
          () => pending.delete(task),
          (error: unknown) => {
            pending.delete(task);
            deps.log(`Response publication failed: ${errorMessage(error)}`);
            closing = true;
            void client.close().then(
              () => finish("response_publication_failed", 1),
              (closeError: unknown) => {
                deps.log(`MCP cleanup failed: ${errorMessage(closeError)}`);
                return finish("response_publication_failed", 1);
              },
            );
          },
        );
      }
      await deps.timer.sleep(50);
    }
    return finished;
  } catch (error) {
    deps.log(`Session driver failed: ${errorMessage(error)}`);
    closing = true;
    try {
      await client.close();
    } catch (closeError) {
      deps.log(`MCP cleanup failed: ${errorMessage(closeError)}`);
    }
    return finish("driver_failed", 1);
  }
}
export async function runProxySessionCommand(
  command: ProxySessionCommand,
  deps: ProxySessionDeps,
): Promise<number> {
  try {
    const refusal = startupRefusal(command, deps);
    if (refusal) {
      deps.log(refusal);
      return 2;
    }
    if (command.op === "serve") {
      return await runServe(command, deps);
    }
    const dir = command.dir;
    if (command.op === "up") {
      validateConfig(command, deps);
      for (const name of ["init.json", "closed.json", "proxy.pid", "driver.pid"]) {
        if (deps.exists(join(dir, name))) {
          deps.log("Use a NEW --dir per proxy launch.");
          return 2;
        }
      }
      deps.mkdir(dir);
      const pid = deps.spawnServe(command);
      const deadline = deps.timer.now() + command.initTimeoutMs + 5000;
      while (deps.timer.now() < deadline) {
        const init = readJson(join(dir, "init.json"), deps);
        if (init) {
          await deps.flush(`${JSON.stringify({ dir, ...init }, null, 2)}\n`);
          return init.ok ? 0 : 1;
        }
        if (deps.exists(join(dir, "closed.json")) || !deps.isPidAlive(pid)) {
          deps.log(
            `Serve exited before initialize; see ${join(dir, "serve.log")} and proxy.stderr.log.`,
          );
          return 1;
        }
        await deps.timer.sleep(100);
      }
      deps.log("Timed out waiting for initialize; the session may still be starting.");
      return 2;
    }
    if (command.op === "status") {
      const pid = (name: string): number | undefined =>
        deps.exists(join(dir, name)) ? Number(deps.readFile(join(dir, name)).trim()) : undefined;
      const proxyPid = pid("proxy.pid"),
        driverPid = pid("driver.pid");
      await deps.flush(
        `${JSON.stringify({ dir, proxyPid, proxyAlive: !!proxyPid && deps.isPidAlive(proxyPid), driverPid, driverAlive: !!driverPid && deps.isPidAlive(driverPid), init: readJson(join(dir, "init.json"), deps), closed: readJson(join(dir, "closed.json"), deps) ?? null }, null, 2)}\n`,
      );
      return 0;
    }
    let args: unknown = {};
    if (command.op === "call") {
      if (command.json !== undefined) {
        args = JSON.parse(
          command.json.startsWith("@") ? deps.readFile(command.json.slice(1)) : command.json,
        );
      }
      const error = deviceStartGuardRefusal(command.tool!, args, {
        allowSelector: command.allowSelector,
      });
      if (error) {
        deps.log(error);
        return 2;
      }
      if (!record(args)) {
        deps.log("Tool arguments must be a JSON object.");
        return 2;
      }
    }
    const init = readJson(join(dir, "init.json"), deps);
    if (!init?.ok || deps.exists(join(dir, "closed.json"))) {
      deps.log("No live initialized session; run up with a NEW --dir first.");
      return 2;
    }
    const id = deps.ids.next();
    const file = `${id}.json`;
    deps.writeJson(join(dir, "in", file), {
      id,
      op: command.op,
      tool: command.tool,
      args,
      uri: command.uri,
      timeoutMs: command.op === "close" ? 30_000 : command.timeoutMs,
      allowSelector: command.allowSelector,
    });
    const deadline =
      deps.timer.now() + (command.op === "close" ? 30_000 : command.timeoutMs) + 10_000;
    while (deps.timer.now() < deadline) {
      const response = readJson(join(dir, "out", file), deps);
      if (response) {
        deps.log(`[response file] ${join(dir, "out", file)}`);
        await deps.flush(`${renderResponse(response, command.full)}\n`);
        return response.ok ? 0 : 1;
      }
      if (deps.exists(join(dir, "closed.json"))) {
        deps.log("Session closed before a response.");
        return command.op === "close" ? 0 : 1;
      }
      await deps.timer.sleep(50);
    }
    deps.log(
      `No response for ${id}; request remains pending, inspect ${join(dir, "out", file)} later.`,
    );
    return 2;
  } catch (error) {
    deps.log(`Proxy session failed: ${errorMessage(error)}`);
    return 2;
  }
}
function realDeps(): ProxySessionDeps {
  const writeJson = (path: string, value: unknown): void => {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  };
  const flush = async (text: string): Promise<void> =>
    new Promise((done, reject) => {
      process.stdout.write(text, (error) => (error ? reject(error) : done()));
    });
  return {
    env: process.env,
    host: {
      homeDirs: [homedir(), userInfo().homedir],
      uid: process.getuid?.() ?? userInfo().username,
    },
    pid: process.pid,
    timer: defaultTimer,
    ids: defaultIdGenerator,
    exists: existsSync,
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
    writeJson,
    appendFile: (path, text) => appendFileSync(path, text, { mode: 0o600 }),
    mkdir: (path) => {
      ensureSecureDirectorySync(path);
    },
    listFiles: readdirSync,
    isPidAlive: isProcessRunning,
    log: console.error,
    flush,
    exit: (code) => {
      process.exitCode = code;
    },
    createClient: (options) => {
      const args = [options.server];
      if (options.config) {
        args.push(MANAGED_SLOT_CONFIG_FLAG, options.config);
      }
      const transport = new StdioClientTransport({
        command: process.execPath,
        args,
        env: options.env,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer) => appendFileSync(options.stderrPath, chunk));
      const client = new Client({ name: "manual-test-proxy-session", version: "1.0.0" });
      client.onclose = options.onClose;
      client.fallbackNotificationHandler = async (notification) => {
        options.onNotification(notification);
      };
      const requestOptions = (
        timeout: number,
      ): { timeout: number; resetTimeoutOnProgress: boolean } => ({
        timeout,
        resetTimeoutOnProgress: true,
      });
      return {
        connect: async (timeout) => {
          await client.connect(transport, { timeout });
        },
        close: () => client.close(),
        pid: () => transport.pid ?? undefined,
        capabilities: () => client.getServerCapabilities() as Record<string, unknown> | undefined,
        serverInfo: () => client.getServerVersion(),
        callTool: (name, args, timeout) =>
          client.callTool({ name, arguments: args }, undefined, requestOptions(timeout)),
        readResource: (uri, timeout) => client.readResource({ uri }, requestOptions(timeout)),
        listTools: (timeout) => client.listTools(undefined, requestOptions(timeout)),
        listResources: (timeout) => client.listResources(undefined, requestOptions(timeout)),
        listResourceTemplates: (timeout) =>
          client.listResourceTemplates(undefined, requestOptions(timeout)),
        subscribeResource: (uri, timeout) =>
          client.subscribeResource({ uri }, requestOptions(timeout)),
      };
    },
    spawnServe: (command) => {
      const args = [
        fileURLToPath(import.meta.url),
        "serve",
        "--dir",
        command.dir,
        "--init-timeout-ms",
        String(command.initTimeoutMs),
      ];
      if (command.config) {
        args.push("--config", command.config);
      }
      for (const [key, value] of Object.entries(command.env)) {
        args.push("--env", `${key}=${value}`);
      }
      const fd = openSync(join(command.dir, "serve.log"), "a", 0o600);
      try {
        const child = spawn(process.execPath, args, {
          detached: true,
          stdio: ["ignore", fd, fd],
          env: process.env,
        });
        child.on("error", (error) => {
          console.error(`Serve launch failed: ${errorMessage(error)}`);
          writeJson(join(command.dir, "closed.json"), {
            reason: "serve_launch_failed",
            error: errorJson(error),
          });
        });
        child.unref();
        if (!child.pid) {
          throw new Error("Serve launch has no pid.");
        }
        return child.pid;
      } finally {
        closeSync(fd);
      }
    },
  };
}
export async function main(): Promise<number> {
  const parsed = parseProxySessionArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }
  return runProxySessionCommand(parsed, realDeps());
}
if (import.meta.main) {
  process.exitCode = await main();
}
