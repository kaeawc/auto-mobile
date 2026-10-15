#!/usr/bin/env bun
import "./harnessLogSink";
import { harnessChildEnvironment, type HarnessLogSinkOverride } from "./harnessLogSink";
import { probeControlSocket } from "./controlSocketProbe";
import { connectFrameSocket } from "./daemon-frame";
import { PROXY_SESSION_COMMANDS, PROXY_SESSION_FLAGS, proxySessionHelp } from "./proxySessionHelp";
/** Persistent manual-test MCP session. Serve remains the stdio proxy's parent and execution
 * owner. Requests are atomically published in in/, responses in out/; no daemon flags are
 * passed to the proxy. Only recorded disposable owners may be signalled after start-identity confirmation. */
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
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  SESSION_CONFIG_FLAG,
  SESSION_EXPERIMENTAL_CAPABILITY,
  parseSessionConfig,
  parseSessionConfigSource,
} from "../../src/models/sessionConfig";
import { defaultLockOwnerGenerationProbe } from "../../src/daemon/lockOwnerGeneration";
import { createFrameBrokerDaemonClient, type BrokerDaemonClient } from "./brokerDaemonClient";
import {
  brokerSocketPath,
  closeBrokerSession,
  liveBrokerStatus,
  runBrokerLifecycle,
} from "./proxySessionLifecycle";
import {
  archiveBrokerAttempt,
  nextBrokerRequest,
  persistBrokerAttempt,
  readBrokerClients,
  readBrokerIdentity,
  resolveBrokerClient,
  type BrokerClientFiles,
} from "./brokerClientFiles";
import { logger } from "../../src/utils/logger";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { defaultIdGenerator, type IdGenerator } from "../../src/utils/IdGenerator";
import { isProcessRunning } from "../../src/utils/processLiveness";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";
import { ensureSecureDirectorySync } from "../../src/utils/tempDir";
import { deviceStartGuardRefusal } from "./deviceStartGuard";
import { privateHarnessEnvRefusal } from "./harnessEnv";
import { createSleepGapDetector, summarizeHostSleepRows } from "./hostSleep";
import {
  canonicalizeHostPath,
  extraEnvRefusal,
  privateClientEnvironment,
  type HostDefaults,
} from "./privateDaemonEnv";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export interface ProxySessionCommand {
  op: (typeof PROXY_SESSION_COMMANDS)[number];
  dir: string;
  client?: string;
  resume?: boolean;
  profile?: string;
  request?: string;
  expect?: string;
  owner?: "driver" | "disposable";
  asClient?: string;
  allowForeignSession?: string;
  all?: boolean;
  env: Record<string, string>;
  initTimeoutMs: number;
  timeoutMs: number;
  full: boolean;
  allowSelector: boolean;
  tool?: string;
  json?: string;
  uri?: string;
}
export function parseProxySessionArgs(
  argv: string[],
): ProxySessionCommand | { error: string } | { help: string } {
  if (
    ["--help", "-h", "help"].includes(argv[0]) ||
    ((PROXY_SESSION_COMMANDS as readonly string[]).includes(argv[0]) &&
      argv.slice(1).some((arg) => arg === "--help" || arg === "-h"))
  ) {
    return { help: proxySessionHelp() };
  }
  const [op, ...args] = argv;
  if (!(PROXY_SESSION_COMMANDS as readonly string[]).includes(op)) {
    return { error: proxySessionHelp() };
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
    if (["--resume", "--all"].includes(flag) && PROXY_SESSION_FLAGS[flag].ops.includes(op)) {
      if (seen.has(flag)) {
        return { error: `Duplicate flag ${flag}.` };
      }
      seen.add(flag);
      if (flag === "--resume") {
        command.resume = true;
      } else {
        command.all = true;
      }
      continue;
    }
    if (flag === "--full" && PROXY_SESSION_FLAGS[flag].ops.includes(op)) {
      command.full = true;
      continue;
    }
    if (flag === "--allow-selector" && PROXY_SESSION_FLAGS[flag].ops.includes(op)) {
      command.allowSelector = true;
      continue;
    }
    const allowed = Object.keys(PROXY_SESSION_FLAGS).filter((flag) =>
      PROXY_SESSION_FLAGS[flag].ops.includes(op),
    );
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
    } else if (flag === "--client") {
      command.client = value;
    } else if (flag === "--profile") {
      command.profile = value;
    } else if (flag === "--request") {
      command.request = value;
    } else if (flag === "--expect") {
      if (value !== "ready" && !/^failed:[a-z0-9_]+$/.test(value)) {
        return { error: "--expect must be ready or failed:<code>." };
      }
      command.expect = value;
    } else if (flag === "--owner") {
      if (value !== "driver" && value !== "disposable") {
        return { error: "--owner must be driver or disposable." };
      }
      command.owner = value;
    } else if (flag === "--as-client") {
      command.asClient = value;
    } else if (flag === "--allow-foreign-session") {
      command.allowForeignSession = value;
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
  const invalid = commandRefusal(command);
  if (invalid) {
    return { error: invalid };
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
    allowForeignSession: z.string().optional(),
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
  logSinkOverride?: readonly HarnessLogSinkOverride[];
  probeDaemonSocket(
    socketPath: string,
    options?: { requireCapability?: string },
  ): Promise<{ alive: boolean; reason?: string }>;
  host: HostDefaults;
  pid: number;
  timer: Timer;
  ids: IdGenerator;
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, text: string, options?: { mode: number; flag: "wx" }): void;
  rename(from: string, to: string): void;
  spawnOwner(): number;
  ownerStartIdentity(pid: number): string | undefined;
  brokerDaemonClient?: BrokerDaemonClient;
  createBrokerDaemonClient?(socketPath: string): BrokerDaemonClient;
  compareOwnerIdentity?(pid: number, identity: string): "same" | "different" | "unknown";
  signalPid?(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  writeJson(path: string, value: unknown): void;
  appendFile(path: string, text: string): void;
  mkdir(path: string): void;
  listFiles(path: string): string[];
  isPidAlive(pid: number): boolean;
  createClient(options: {
    server: string;
    sessionConfig?: string;
    livenessOwnerToken?: string;
    redact(text: string): string;
    env: Record<string, string>;
    stderrPath: string;
    onClose(): void;
    onNotification(notification: unknown): void;
  }): ProxySessionClient;
  spawnServe(command: ProxySessionCommand, env: Record<string, string>): number;
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
  return privateClientEnvironment(
    harnessChildEnvironment(deps.env, deps.logSinkOverride),
    command.env,
  );
}
async function startupRefusal(
  command: ProxySessionCommand,
  deps: ProxySessionDeps,
): Promise<string | undefined> {
  const env = privateEnv(command, deps);
  const refusal = extraEnvRefusal(command.env) ?? privateHarnessEnvRefusal(env, deps.host);
  if (refusal || (command.op !== "up" && command.op !== "serve")) {
    return refusal;
  }
  const startFirst =
    "Run private-daemon.ts start first; proxy up/serve must not wake a dead daemon.";
  try {
    const data = readJson(env.AUTOMOBILE_DAEMON_PID_FILE_PATH, deps);
    const pid = data?.pid;
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      !deps.isPidAlive(pid)
    ) {
      return startFirst;
    }
  } catch (error) {
    deps.log(`Private daemon pid file is invalid: ${errorMessage(error)}`);
    return startFirst;
  }
  const probe = await deps.probeDaemonSocket(
    env.AUTOMOBILE_DAEMON_SOCKET_PATH,
    command.client ? { requireCapability: "session-broker/v1" } : undefined,
  );
  return probe.alive
    ? undefined
    : `${startFirst} ${probe.reason ?? "Control socket did not answer."}`;
}
function commandRefusal(command: ProxySessionCommand): string | undefined {
  if (command.all) {
    if (command.op !== "status" || command.client || command.dir) {
      return "--all is only for status and excludes --client/--dir.";
    }
  } else if (!!command.client === !!command.dir) {
    return "Exactly one of --client or --dir is required.";
  }
  if (["release", "abandon", "info", "owner-kill"].includes(command.op) && !command.client) {
    return `${command.op} requires --client.`;
  }
  if (command.asClient && (!command.client || !["release", "abandon"].includes(command.op))) {
    return "--as-client requires release/abandon --client.";
  }
  if (command.profile && command.request) {
    return "--profile and --request are mutually exclusive.";
  }
  if (command.resume && (command.profile || command.request || command.owner)) {
    return "--resume cannot change profile, request or owner.";
  }
  if (command.client && command.allowSelector) {
    return "--allow-selector is unavailable for broker clients.";
  }
  if (
    !command.client &&
    (command.profile ||
      command.request ||
      command.resume ||
      command.owner ||
      command.expect ||
      command.allowForeignSession)
  ) {
    return "Broker flags require --client.";
  }
  return undefined;
}
function clientContext(
  command: ProxySessionCommand,
  deps: ProxySessionDeps,
): BrokerClientFiles | undefined {
  return command.client ? resolveBrokerClient(deps.env.MT_BATCH, command.client, deps) : undefined;
}
function redactBrokerDeps(
  context: BrokerClientFiles | undefined,
  deps: ProxySessionDeps,
): ProxySessionDeps {
  if (!context) {
    return deps;
  }
  // Resolve at every write: up mints the token after this dependency wrapper is installed.
  const redact = (text: string): string => {
    for (const name of readBrokerClients(context.batch, deps)) {
      const path = join(context.batch, "sessions", name, "owner-token");
      const token = deps.exists(path) ? deps.readFile(path) : "";
      if (token) {
        text = text
          .replaceAll(token, "[REDACTED]")
          .replaceAll(JSON.stringify(token).slice(1, -1), "[REDACTED]");
      }
    }
    return text;
  };
  return {
    ...deps,
    log: (text) => deps.log(redact(text)),
    flush: (text) => deps.flush(redact(text)),
    writeJson: (path, value) => deps.writeJson(path, JSON.parse(redact(JSON.stringify(value)))),
    appendFile: (path, text) => deps.appendFile(path, redact(text)),
  };
}
function driverAlive(dir: string, deps: ProxySessionDeps): boolean {
  const path = join(dir, "driver.pid");
  const pid = deps.exists(path) ? Number(deps.readFile(path).trim()) : NaN;
  return Number.isSafeInteger(pid) && pid > 0 && deps.isPidAlive(pid);
}
function brokerOutcome(init: Record<string, unknown>, expected: string | undefined): number {
  const session = record(init.session);
  const outcome = init.ok ? session?.outcome : undefined;
  const label = outcome === "failed" ? `failed:${record(session?.failure)?.code}` : outcome;
  return expected ? (expected === label ? 0 : 2) : outcome === "ready" ? 0 : 1;
}
function brokerRequestRefusal(
  request: Pick<Request, "op" | "tool" | "args" | "uri" | "allowSelector" | "allowForeignSession">,
  context: BrokerClientFiles,
  session: Record<string, unknown> | undefined,
  deps: ProxySessionDeps,
): string | undefined {
  if (
    session?.outcome !== "ready" ||
    typeof session.sessionUuid !== "string" ||
    !session.sessionUuid ||
    !driverAlive(context.dir, deps)
  ) {
    return "Broker client requires a ready session and live driver; no sessionless calls.";
  }
  if (request.allowSelector) {
    return "--allow-selector is unavailable for broker clients.";
  }
  if (
    request.op === "resources" ||
    (["read", "subscribe"].includes(request.op) &&
      (request.uri === "automobile:devices" || request.uri?.startsWith("automobile:devices/")))
  ) {
    return "Broker clients cannot access device inventory resources.";
  }
  if (
    request.op === "call" &&
    ["startDevice", "provisionDevice", "getAndroid", "getApple", "killDevice"].includes(
      request.tool ?? "",
    )
  ) {
    return `Broker clients refuse ${request.tool}.`;
  }
  let allowed = session.sessionUuid;
  if (request.allowForeignSession) {
    if (request.allowForeignSession === context.name) {
      return "--allow-foreign-session must name another batch client.";
    }
    const foreign = resolveBrokerClient(context.batch, request.allowForeignSession, deps);
    const grant = record(readJson(join(foreign.dir, "init.json"), deps)?.session);
    if (grant?.outcome !== "ready" || typeof grant.sessionUuid !== "string") {
      return "Foreign client has no ready grant.";
    }
    allowed = grant.sessionUuid;
  }
  const inspect = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      return value.every(inspect);
    }
    const fields = record(value);
    return (
      !fields ||
      Object.entries(fields).every(([key, entry]) =>
        ["sessionUuid", "deviceId"].includes(key)
          ? entry === session.sessionUuid || entry === allowed
          : inspect(entry),
      )
    );
  };
  return inspect(request.args)
    ? undefined
    : "Explicit sessionUuid/deviceId must equal this client's grant (or the named foreign client's grant).";
}
function prepareBrokerClient(
  command: ProxySessionCommand,
  context: BrokerClientFiles,
  deps: ProxySessionDeps,
): void {
  if (driverAlive(context.dir, deps)) {
    throw new Error("Previous attempt driver is alive; close it before another up/serve.");
  }
  if (command.resume) {
    readBrokerIdentity(context, deps);
    archiveBrokerAttempt(context, true, deps);
    return;
  }
  let config = nextBrokerRequest(context, deps);
  if (command.request) {
    config = {
      ...parseSessionConfigSource(command.request, deps.readFile),
      requestId: config.requestId,
    };
  }
  if (command.profile) {
    const device = command.profile.trim().startsWith("{")
      ? JSON.parse(command.profile)
      : { ...config.device, hardware: { kind: "archetype", archetype: command.profile } };
    config = parseSessionConfig({ ...config, device });
  }
  config = parseSessionConfig(config);
  if (config.executionOwnerPid !== undefined) {
    throw new Error("Use --owner disposable; external execution owners are not harness-owned.");
  }
  archiveBrokerAttempt(context, false, deps);
  deps.mkdir(context.dir);
  if (command.owner === "disposable") {
    const pid = deps.spawnOwner();
    // Record ownership immediately, even if generation capture subsequently fails.
    deps.writeFile(join(context.dir, "owner.pid"), `${pid}\n`);
    const identity = deps.ownerStartIdentity(pid);
    if (!identity) {
      throw new Error("Cannot capture disposable owner's process start identity; see owner.pid.");
    }
    deps.writeFile(join(context.dir, "owner-identity"), identity);
    config = parseSessionConfig({
      ...config,
      executionOwnerPid: pid,
      executionOwnerStartIdentity: identity,
    });
  }
  persistBrokerAttempt(context, config, deps);
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
    } catch (error) {
      // Plain text is a valid MCP payload; retaining it does not hide a request failure.
      logger.debug(`MCP payload is plain text: ${errorMessage(error)}`);
      payload = text;
    }
  }
  return JSON.stringify(
    { ok: response.ok, ms: response.ms, isError: result?.isError, payload },
    null,
    2,
  );
}
async function servePrepared(
  command: ProxySessionCommand,
  deps: ProxySessionDeps,
): Promise<number> {
  const refusal = await startupRefusal(command, deps);
  if (refusal) {
    deps.log(refusal);
    return 2;
  }
  const context = clientContext(command, deps);
  const identity = context ? readBrokerIdentity(context, deps) : undefined;
  const dir = command.dir;
  for (const name of ["init.json", "driver.pid", "proxy.pid", "closed.json"]) {
    if (
      deps.exists(join(dir, name)) &&
      !(context && name === "driver.pid" && Number(deps.readFile(join(dir, name))) === deps.pid)
    ) {
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
  const hostSleepRows: Array<{ id: string; invalid?: string }> = [];
  const finish = async (reason: string, code: number): Promise<number> => {
    if (finished !== undefined) {
      return finished;
    }
    finished = code;
    const hostSleepLines = summarizeHostSleepRows(hostSleepRows);
    if (hostSleepLines.length > 0) {
      deps.writeJson(join(dir, "host-sleep.json"), {
        invalidIds: hostSleepRows
          .filter((row) => row.invalid === "host-slept")
          .map((row) => row.id),
        lines: hostSleepLines,
      });
    }
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
    sessionConfig: context ? join(dir, "request.json") : undefined,
    livenessOwnerToken: identity?.token,
    redact: (text) => (identity ? text.replaceAll(identity.token, "[REDACTED]") : text),
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
  event("spawn", { sessionConfig: context ? join(dir, "request.json") : null });
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
      serverInfo: client.serverInfo(),
      capabilities,
      session: record(capabilities?.experimental)?.[SESSION_EXPERIMENTAL_CAPABILITY] ?? null,
      daemonSocketAlive: (await deps.probeDaemonSocket(env.AUTOMOBILE_DAEMON_SOCKET_PATH)).alive,
    });
    event("initialized");
    const handle = async (request: Request): Promise<unknown> => {
      const timeout = request.timeoutMs ?? command.timeoutMs;
      if (context) {
        const refusal = brokerRequestRefusal(
          request,
          context,
          record(readJson(join(dir, "init.json"), deps)?.session),
          deps,
        );
        if (refusal) {
          throw new Error(refusal);
        }
      }
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
    const sleepDetector = createSleepGapDetector(deps.timer);
    while (finished === undefined) {
      for (const file of deps
        .listFiles(join(dir, "in"))
        .filter((file) => file.endsWith(".json") && !seen.has(file))
        .sort()) {
        let input: unknown;
        try {
          input = JSON.parse(deps.readFile(join(dir, "in", file)));
        } catch (error) {
          // A writer may still be publishing the file; leave it unseen and retry next poll.
          deps.log(`Incomplete inbox request ${file}; retrying: ${errorMessage(error)}`);
          continue;
        }
        seen.add(file);
        const parsed = requestSchema.safeParse(input);
        if (!parsed.success) {
          deps.log(`Invalid inbox request ${file}: ${errorMessage(parsed.error)}`);
          deps.writeJson(join(dir, "out", file), {
            id: record(input)?.id,
            ok: false,
            error: errorJson(parsed.error),
          });
          continue;
        }
        const request = parsed.data;
        sleepDetector.sample();
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
          sleepDetector.sample();
          const gap = sleepDetector
            .gaps()
            .find((candidate) => candidate.endMs > t0 && candidate.startMs < deps.timer.now());
          if (gap) {
            body = { ...body, invalid: "host-slept", hostSleptMs: gap.sleptMs };
            hostSleepRows.push({ id: request.id, invalid: "host-slept" });
            event("host_slept", { id: request.id, sleptMs: gap.sleptMs });
          }
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
/** Public serve entry point prepares direct launches; spawned serve reuses persisted identity. */
export async function runServe(
  command: ProxySessionCommand,
  deps: ProxySessionDeps,
): Promise<number> {
  return runProxySessionCommand({ ...command, op: "serve" }, deps);
}
async function statusAll(command: ProxySessionCommand, deps: ProxySessionDeps): Promise<number> {
  const rows = [
    "client\toutcome\tsessionUuid\tfailure\tretryable\tcleanupPending\townerAlive\tdriverAlive\tdaemonSocketAlive\tprofile\tliveStatus",
  ];
  const alive = (
    await deps.probeDaemonSocket(
      deps.createBrokerDaemonClient
        ? brokerSocketPath(deps)
        : privateEnv(command, deps).AUTOMOBILE_DAEMON_SOCKET_PATH,
    )
  ).alive;
  for (const name of readBrokerClients(deps.env.MT_BATCH, deps)) {
    const context = resolveBrokerClient(deps.env.MT_BATCH, name, deps);
    deps = redactBrokerDeps(context, deps);
    const session = record(readJson(join(context.dir, "init.json"), deps)?.session);
    const ownerPath = join(context.dir, "owner.pid");
    const ownerPid = deps.exists(ownerPath) ? Number(deps.readFile(ownerPath)) : undefined;
    const driver = driverAlive(context.dir, deps);
    rows.push(
      [
        name,
        session?.outcome ?? "not_started",
        session?.sessionUuid ?? "-",
        record(session?.failure)?.code ?? "-",
        record(session?.failure)?.retryable ?? "-",
        session?.cleanupPending ?? "-",
        ownerPid ? deps.isPidAlive(ownerPid) : driver,
        driver,
        alive,
        JSON.stringify(session?.profile ?? null),
        JSON.stringify(await liveBrokerStatus(context, deps)),
      ].join("\t"),
    );
  }
  await deps.flush(`${rows.join("\n")}\n`);
  return 0;
}
export async function runProxySessionCommand(
  command: ProxySessionCommand,
  deps: ProxySessionDeps,
): Promise<number> {
  try {
    const invalid = commandRefusal(command);
    if (invalid) {
      deps.log(invalid);
      return 2;
    }
    if (command.all) {
      const refusal = await startupRefusal(command, deps);
      if (refusal) {
        deps.log(refusal);
        return 2;
      }
      return await statusAll(command, deps);
    }
    const context = clientContext(command, deps);
    deps = redactBrokerDeps(context, deps);
    if (context) {
      command = { ...command, dir: context.dir };
    }
    const refusal = await startupRefusal(command, deps);
    if (refusal) {
      deps.log(refusal);
      return 2;
    }
    if (command.op === "serve") {
      if (context) {
        const pidPath = join(context.dir, "driver.pid");
        const ownLaunch = deps.exists(pidPath) && Number(deps.readFile(pidPath)) === deps.pid;
        if (
          deps.exists(join(context.dir, "request.json")) &&
          (ownLaunch ||
            (!deps.exists(pidPath) && !command.profile && !command.request && !command.owner))
        ) {
          readBrokerIdentity(context, deps);
        } else {
          prepareBrokerClient(command, context, deps);
        }
      }
      return await servePrepared(command, deps);
    }
    const dir = command.dir;
    if (context && ["release", "abandon", "info", "owner-kill"].includes(command.op)) {
      return await runBrokerLifecycle(command, context, deps);
    }
    if (command.op === "up") {
      if (context) {
        prepareBrokerClient(command, context, deps);
      }
      for (const name of ["init.json", "closed.json", "proxy.pid", "driver.pid"]) {
        if (deps.exists(join(dir, name))) {
          deps.log("Use a NEW --dir per proxy launch.");
          return 2;
        }
      }
      deps.mkdir(dir);
      const pid = deps.spawnServe(command, privateEnv(command, deps));
      if (context) {
        deps.writeFile(join(dir, "driver.pid"), `${pid}\n`);
      }
      const deadline = deps.timer.now() + command.initTimeoutMs + 5000;
      while (deps.timer.now() < deadline) {
        const init = readJson(join(dir, "init.json"), deps);
        if (init) {
          await deps.flush(`${JSON.stringify({ dir, ...init }, null, 2)}\n`);
          if (context) {
            const session = record(init.session);
            if (session?.outcome !== "ready") {
              deps.log(
                String(
                  record(session?.failure)?.code ??
                    (session?.outcome === "pending"
                      ? "session_status_unresolved"
                      : "session_broker_unavailable"),
                ),
              );
            }
            return brokerOutcome(init, command.expect);
          }
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
      const daemonSocket = await deps.probeDaemonSocket(
        context && deps.createBrokerDaemonClient
          ? brokerSocketPath(deps)
          : privateEnv(command, deps).AUTOMOBILE_DAEMON_SOCKET_PATH,
      );
      const pid = (name: string): number | undefined =>
        deps.exists(join(dir, name)) ? Number(deps.readFile(join(dir, name)).trim()) : undefined;
      const proxyPid = pid("proxy.pid"),
        driverPid = pid("driver.pid"),
        ownerPid = pid("owner.pid") ?? driverPid;
      const session = record(readJson(join(dir, "init.json"), deps)?.session) ?? null;
      const liveStatus = context ? await liveBrokerStatus(context, deps) : undefined;
      await deps.flush(
        `${JSON.stringify({ dir, session, liveStatus, ownerPid, ownerAlive: !!ownerPid && deps.isPidAlive(ownerPid), daemonSocketAlive: daemonSocket.alive, proxyPid, proxyAlive: !!proxyPid && deps.isPidAlive(proxyPid), driverPid, driverAlive: !!driverPid && deps.isPidAlive(driverPid), init: readJson(join(dir, "init.json"), deps), closed: readJson(join(dir, "closed.json"), deps) ?? null }, null, 2)}\n`,
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
      const error = context
        ? undefined
        : deviceStartGuardRefusal(command.tool!, args, {
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
    if (context && command.op === "close" && deps.exists(join(dir, "closed.json"))) {
      await closeBrokerSession(context, deps);
      return 0;
    }
    if (context && command.op !== "close") {
      const refusal = brokerRequestRefusal(
        {
          op: command.op as Request["op"],
          tool: command.tool,
          args: record(args),
          uri: command.uri,
          allowSelector: command.allowSelector,
          allowForeignSession: command.allowForeignSession,
        },
        context,
        record(init?.session),
        deps,
      );
      if (refusal) {
        deps.log(refusal);
        return 2;
      }
    }
    if (
      !init?.ok ||
      deps.exists(join(dir, "closed.json")) ||
      (context && !driverAlive(dir, deps))
    ) {
      deps.log(
        "No live initialized session; use the batch wrapper: up --client NAME (or plain up with a NEW --dir).",
      );
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
      allowForeignSession: command.allowForeignSession,
    });
    const deadline =
      deps.timer.now() + (command.op === "close" ? 30_000 : command.timeoutMs) + 10_000;
    while (deps.timer.now() < deadline) {
      const response = readJson(join(dir, "out", file), deps);
      if (response) {
        deps.log(`[response file] ${join(dir, "out", file)}`);
        if (response.ok && context && command.op === "close") {
          await closeBrokerSession(context, deps);
        }
        await deps.flush(`${renderResponse(response, command.full)}\n`);
        return response.ok ? 0 : 1;
      }
      if (deps.exists(join(dir, "closed.json"))) {
        deps.log("Session closed before a response.");
        if (context && command.op === "close") {
          await closeBrokerSession(context, deps);
        }
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
    env: harnessChildEnvironment(process.env),
    probeDaemonSocket: (path, options) =>
      probeControlSocket(
        path,
        {
          connect: connectFrameSocket,
          timer: defaultTimer,
          ids: defaultIdGenerator,
        },
        options,
      ),
    host: {
      homeDirs: [homedir(), userInfo().homedir],
      uid: process.getuid?.() ?? userInfo().username,
      canonicalize: canonicalizeHostPath,
    },
    pid: process.pid,
    timer: defaultTimer,
    ids: defaultIdGenerator,
    exists: existsSync,
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, text, options) => writeFileSync(path, text, options ?? { mode: 0o600 }),
    rename: renameSync,
    ownerStartIdentity: (pid) => defaultLockOwnerGenerationProbe.current(pid),
    compareOwnerIdentity: (pid, identity) => defaultLockOwnerGenerationProbe.compare(pid, identity),
    signalPid: (pid, signal) => {
      process.kill(pid, signal);
    },
    createBrokerDaemonClient: (socketPath) => createFrameBrokerDaemonClient({ socketPath }),
    spawnOwner: () => {
      const child = spawn("sleep", ["86400"], { detached: true, stdio: "ignore" });
      child.on("error", (error) =>
        console.error(`Disposable owner failed: ${errorMessage(error)}`),
      );
      child.unref();
      if (!child.pid) {
        throw new Error("Disposable owner has no pid.");
      }
      return child.pid;
    },
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
      if (options.sessionConfig && options.livenessOwnerToken) {
        args.push(
          SESSION_CONFIG_FLAG,
          options.sessionConfig,
          "--liveness-owner-token",
          options.livenessOwnerToken,
        );
      }
      const transport = new StdioClientTransport({
        command: process.execPath,
        args,
        env: options.env,
        stderr: "pipe",
      });
      // Buffer complete stderr lines so a token split across transport chunks cannot leak.
      let stderrBuffer = "";
      const stderrDecoder = new StringDecoder("utf8");
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderrBuffer += stderrDecoder.write(chunk);
        const end = stderrBuffer.lastIndexOf("\n");
        if (end >= 0) {
          appendFileSync(options.stderrPath, options.redact(stderrBuffer.slice(0, end + 1)));
          stderrBuffer = stderrBuffer.slice(end + 1);
        }
      });
      transport.stderr?.on("end", () => {
        appendFileSync(options.stderrPath, options.redact(stderrBuffer + stderrDecoder.end()));
        stderrBuffer = "";
      });
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
    spawnServe: (command, env) => {
      const args = [
        fileURLToPath(import.meta.url),
        "serve",
        command.client ? "--client" : "--dir",
        command.client ?? command.dir,
        "--init-timeout-ms",
        String(command.initTimeoutMs),
      ];
      for (const [key, value] of Object.entries(command.env)) {
        args.push("--env", `${key}=${value}`);
      }
      const fd = openSync(join(command.dir, "serve.log"), "a", 0o600);
      try {
        const child = spawn(process.execPath, args, {
          detached: true,
          stdio: ["ignore", fd, fd],
          env,
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
    console.error(`${parsed.error}\nRun proxy-session --help for usage.`);
    return 2;
  }
  if ("help" in parsed) {
    console.log(parsed.help);
    return 0;
  }
  return runProxySessionCommand(parsed, realDeps());
}
if (import.meta.main) {
  process.exitCode = await main();
}
