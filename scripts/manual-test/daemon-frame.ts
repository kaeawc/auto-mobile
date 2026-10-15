#!/usr/bin/env bun
import "./harnessLogSink";
import { DAEMON_CLIENT_MAX_FRAME_BYTES } from "../../src/daemon/socketServer/LineFramer";
import * as daemonConstants from "../../src/daemon/constants";
import { DAEMON_FRAME_COMMANDS, DAEMON_FRAME_FLAGS, daemonFrameHelp } from "./daemonFrameHelp";
import { substituteFramePlaceholders, type BrokerFrameIdentity } from "./daemonFramePlaceholders";
import { existsSync, readFileSync } from "node:fs";
import { Socket } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DAEMON_SESSION_NOT_FOUND_CODE,
  type DaemonRequest,
  type DaemonResponse,
} from "../../src/daemon/types";
import {
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_CANCEL_REQUEST_METHOD,
  CLI_SESSION_LIVENESS_POLICY,
  CLI_KEEPER_LIVENESS_OWNER_KIND,
  DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS,
  HEARTBEAT_SESSION_LIVENESS_POLICY,
} from "../../src/daemon/constants";
import {
  acquireSessionThroughDaemon,
  DAEMON_RELEASE_BROKER_SESSION_METHOD,
} from "../../src/daemon/sessionBrokerProxyAcquisition";
import { BROKER_CLEANUP_TIMEOUT_MS } from "./brokerDaemonClient";
import { readToolEnvelopePayload } from "../../src/utils/toolEnvelopePayload";
import {
  isBrokerBatch,
  readBrokerClients,
  readBrokerIdentity,
  resolveBrokerClient,
} from "./brokerClientFiles";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  PROXY_HEARTBEAT_INTERVAL_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { parseSessionConfig, type SessionConfig } from "../../src/models/sessionConfig";
import { defaultTimer, MAX_SETTIMEOUT_DELAY_MS, type Timer } from "../../src/utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../../src/utils/IdGenerator";
import { readEnvPositiveInteger } from "../../src/utils/envNumbers";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { raceWithDeadline } from "../../src/utils/raceWithDeadline";
import { privateHarnessEnvRefusal } from "./harnessEnv";
import { deviceStartGuardRefusal } from "./deviceStartGuard";
import {
  canonicalizeHostPath,
  privatePathRefusal,
  privateClientEnvironment,
  type HostDefaults,
} from "./privateDaemonEnv";
import {
  encodeDaemonFrame,
  LineDecoder,
  type FrameConnection,
  type ConnectFrameSocket,
} from "./frameWire";

const usage = daemonFrameHelp();
export interface DaemonFrameCommand {
  method: string;
  externalKeeper?: boolean;
  json?: string;
  socket?: string;
  type?: DaemonRequest["type"];
  count: number;
  timeoutMs: number;
  mode: "send" | "cancel" | "cancel-after" | "cancel-keep-open";
  keepOpenMs: number;
  then: { method: string; json?: string }[];
  cancelAfterMs?: number;
  brokerBinding?: string;
  tokenOf?: string;
  expectRefused: boolean;
  holdMs: number;
  allowSelector: boolean;
  allowHostMutation: boolean;
}
function frameHelpRequested(argv: string[]): boolean {
  return (
    ["--help", "-h", "help"].includes(argv[0]) ||
    ((DAEMON_FRAME_COMMANDS as readonly string[]).includes(argv[0]) &&
      argv.slice(1).some((arg) => arg === "--help" || arg === "-h"))
  );
}
function lowerFrameConvenience(argv: string[]): string[] | { error: string } {
  const [op, sessionId] = argv;
  if (op !== "session-info" && op !== "heartbeat") {
    return argv;
  }
  if (!sessionId || sessionId.startsWith("-")) {
    return { error: `${op} requires a sessionId.` };
  }
  const params =
    op === "session-info"
      ? { sessionId }
      : {
          sessionId,
          livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
          livenessOwnerKind: CLI_KEEPER_LIVENESS_OWNER_KIND,
          idleTimeoutMs: DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS,
        };
  return [
    "send",
    op === "session-info" ? "daemon/sessionInfo" : DAEMON_HEARTBEAT_METHOD,
    JSON.stringify(params),
    ...argv.slice(2),
  ];
}
function frameValueRefusal(
  flag: string,
  value: string | undefined,
  duplicate: boolean,
): string | undefined {
  return !value || value.startsWith("--") || duplicate
    ? `Missing/duplicate value for ${flag}.`
    : undefined;
}
function parseThenFrame(value: string): { method: string; json?: string } | { error: string } {
  const split = value.search(/\s/);
  const method = split < 0 ? value : value.slice(0, split);
  if (!method || method.startsWith("-")) {
    return { error: "--then requires a method and optional params JSON." };
  }
  return { method, json: split < 0 ? undefined : value.slice(split).trim() || undefined };
}
function readFrameArguments(
  argv: string[],
  command: DaemonFrameCommand,
): Record<string, string> | { error: string } {
  const values: Record<string, string> = {};
  const booleans = {
    "--allow-selector": "allowSelector",
    "--expect-refused": "expectRefused",
    "--allow-host-mutation": "allowHostMutation",
  } as const;
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (Object.hasOwn(booleans, flag)) {
      command[booleans[flag as keyof typeof booleans]] = true;
      continue;
    }
    if (!flag.startsWith("--") && command.json === undefined) {
      command.json = flag;
      continue;
    }
    if (!(flag in DAEMON_FRAME_FLAGS) || flag === "--help") {
      return { error: `Unknown argument ${flag}.` };
    }
    const value = argv[++i];
    const error = frameValueRefusal(flag, value, values[flag] !== undefined && flag !== "--then");
    if (error) {
      return { error };
    }
    if (flag === "--then") {
      const frame = parseThenFrame(value);
      if ("error" in frame) {
        return frame;
      }
      command.then.push(frame);
    } else {
      values[flag] = value;
    }
  }
  return values;
}
function frameTimerValid(value: string, minimum: number): boolean {
  const ms = Number(value);
  return (
    /^\d+$/.test(value) &&
    Number.isSafeInteger(ms) &&
    ms >= minimum &&
    ms <= MAX_SETTIMEOUT_DELAY_MS
  );
}
function assignFrameNumbers(
  values: Record<string, string>,
  command: DaemonFrameCommand,
): string | undefined {
  for (const [flag, field, minimum] of [
    ["--count", "count", 1],
    ["--timeout-ms", "timeoutMs", 1],
    ["--hold-ms", "holdMs", 0],
    ["--cancel-after-ms", "cancelAfterMs", 0],
  ] as const) {
    if (values[flag] === undefined) {
      continue;
    }
    if (!frameTimerValid(values[flag], minimum)) {
      return `${flag} must be an integer from ${minimum} to ${MAX_SETTIMEOUT_DELAY_MS}.`;
    }
    command[field] = Number(values[flag]);
  }
  return undefined;
}
function parseFrameMode(mode: string, command: DaemonFrameCommand): string | undefined {
  if (mode === "send" || mode === "cancel") {
    command.mode = mode;
    return undefined;
  }
  const [name, raw, ...rest] = mode.split(":");
  if (rest.length || !["cancel-after", "cancel-keep-open"].includes(name)) {
    return "Invalid --mode.";
  }
  if (name === "cancel-after" && raw === undefined) {
    return "Invalid cancellation delay/window.";
  }
  if (!frameTimerValid(raw ?? "5000", 0)) {
    return "Invalid cancellation delay/window.";
  }
  const ms = Number(raw ?? "5000");
  if (name === "cancel-after") {
    command.mode = name;
    command.cancelAfterMs = ms;
  } else {
    command.mode = "cancel-keep-open";
    command.keepOpenMs = ms;
  }
  return undefined;
}
function frameTypeValid(type: string | undefined): type is DaemonRequest["type"] | undefined {
  return type === undefined || type === "mcp_request" || type === "daemon_request";
}
function frameSendShapeValid(argv: string[]): boolean {
  return argv[0] === "send" && !!argv[1] && !argv[1].startsWith("--");
}
function frameAssignmentsRefusal(
  values: Record<string, string>,
  command: DaemonFrameCommand,
): string | undefined {
  return (
    assignFrameNumbers(values, command) ??
    parseFrameMode(values["--mode"] ?? "send", command) ??
    frameModeCombinationRefusal(command, values)
  );
}
function frameModeCombinationRefusal(
  command: DaemonFrameCommand,
  values: Record<string, string>,
): string | undefined {
  if (command.brokerBinding && command.allowSelector) {
    return "--allow-selector is unavailable with --broker-binding.";
  }
  if (command.expectRefused && (!command.brokerBinding || command.mode !== "send")) {
    return "--expect-refused requires --broker-binding and --mode send.";
  }
  if (command.tokenOf && !command.brokerBinding) {
    return "--token-of requires --broker-binding.";
  }
  if (command.then.length && command.mode !== "send") {
    return "--then requires --mode send.";
  }
  if (values["--cancel-after-ms"] !== undefined && command.mode !== "cancel-keep-open") {
    return "--cancel-after-ms requires cancel-keep-open.";
  }
  if (
    command.mode === "cancel-keep-open" &&
    (command.cancelAfterMs ?? 0) + command.keepOpenMs > MAX_SETTIMEOUT_DELAY_MS
  ) {
    return "Cancellation delay plus window exceeds the timer-safe maximum.";
  }
  return undefined;
}
export function parseDaemonFrameArgs(
  argv: string[],
): DaemonFrameCommand | { error: string } | { help: string } {
  if (frameHelpRequested(argv)) {
    return { help: usage };
  }
  const lowered = lowerFrameConvenience(argv);
  if ("error" in lowered) {
    return lowered;
  }
  if (!frameSendShapeValid(lowered)) {
    return { error: usage };
  }
  const command: DaemonFrameCommand = {
    method: lowered[1],
    count: 1,
    timeoutMs: 30_000,
    mode: "send",
    keepOpenMs: 5000,
    then: [],
    holdMs: 0,
    allowSelector: false,
    expectRefused: false,
    allowHostMutation: false,
    ...(argv[0] === "heartbeat" ? { externalKeeper: true } : {}),
  };
  const values = readFrameArguments(lowered, command);
  if ("error" in values) {
    return { error: values.error };
  }
  const type = values["--type"];
  if (!frameTypeValid(type)) {
    return { error: "Invalid --type." };
  }
  command.type = type;
  command.socket = values["--socket"];
  command.brokerBinding = values["--broker-binding"];
  command.tokenOf = values["--token-of"];
  const error = frameAssignmentsRefusal(values, command);
  return error ? { error } : command;
}

export interface DaemonFrameDeps {
  env: Record<string, string | undefined>;
  host: HostDefaults;
  connect: ConnectFrameSocket;
  timer: Timer;
  ids: IdGenerator;
  readFile(path: string): string;
  exists(path: string): boolean;
  out(line: string): void;
  err(line: string): void;
}
/** No handshake, reconnect, rebind or hidden request ids. */
export class FrameRpc {
  private pending = new Map<
    string,
    {
      done(response: DaemonResponse | undefined): void;
      reject(error: Error): void;
      timeout: NodeJS.Timeout;
    }
  >();
  private failure?: Error;
  private pauses = new Set<(error: Error) => void>();
  private decoder: LineDecoder;
  private startedAt: number;
  constructor(
    readonly connection: FrameConnection,
    private readonly deps: Pick<DaemonFrameDeps, "timer" | "ids" | "out">,
    // Same control answers as DaemonClient: 256 MiB, including file/video payloads.
    maxFrameBytes = DAEMON_CLIENT_MAX_FRAME_BYTES,
    private readonly redact = (text: string): string => text,
  ) {
    this.decoder = new LineDecoder(maxFrameBytes, "Control response");
    this.startedAt = deps.timer.now();
    connection.onData((chunk) => {
      const { lines, overflow } = this.decoder.push(chunk);
      for (const line of lines) {
        deps.out(`[${deps.timer.now() - this.startedAt}ms] ${line}`);
        try {
          const response: DaemonResponse = JSON.parse(line);
          if (response.type !== "mcp_response" || typeof response.id !== "string") {
            continue;
          }
          const waiting = this.pending.get(response.id);
          if (!waiting) {
            continue;
          }
          this.pending.delete(response.id);
          deps.timer.clearTimeout(waiting.timeout);
          waiting.done(response);
        } catch (error) {
          this.fail(new Error(`Invalid control JSON: ${errorMessage(error)}`));
        }
      }
      if (overflow) {
        this.fail(overflow);
        connection.destroy();
      }
    });
    connection.onClose((error) => this.fail(error ?? new Error("Control socket closed.")));
  }
  fail(error: Error): void {
    error = new Error(this.redact(error.message));
    this.failure ??= error;
    for (const waiting of this.pending.values()) {
      this.deps.timer.clearTimeout(waiting.timeout);
      waiting.reject(error);
    }
    this.pending.clear();
    for (const reject of this.pauses) {
      reject(error);
    }
    this.pauses.clear();
  }
  assertOpen(): void {
    if (this.failure) {
      throw this.failure;
    }
  }
  pause(ms: number): Promise<void> {
    this.assertOpen();
    return new Promise((done, reject) => {
      const failed = (error: Error): void => {
        this.deps.timer.clearTimeout(handle);
        this.pauses.delete(failed);
        reject(error);
      };
      const handle = this.deps.timer.setTimeout(() => {
        this.pauses.delete(failed);
        done();
      }, ms);
      this.pauses.add(failed);
    });
  }
  beginRequest(
    method: string,
    params: unknown,
    timeoutMs: number,
    type?: DaemonRequest["type"],
    readWindowMs = timeoutMs,
  ): { id: string; answer: Promise<DaemonResponse | undefined> } {
    this.assertOpen();
    const id = this.deps.ids.next();
    const answer = new Promise<DaemonResponse | undefined>((done, reject) => {
      const timeout = this.deps.timer.setTimeout(() => {
        this.pending.delete(id);
        done(undefined);
      }, readWindowMs);
      this.pending.set(id, { done, reject, timeout });
      try {
        this.connection.write(encodeDaemonFrame({ id, method, params, timeoutMs, type }));
      } catch (error) {
        this.fail(new Error(`Control write failed: ${errorMessage(error)}`));
      }
    });
    return { id, answer };
  }
  request(
    method: string,
    params: unknown,
    timeoutMs: number,
    type?: DaemonRequest["type"],
  ): Promise<DaemonResponse> {
    return this.beginRequest(method, params, timeoutMs, type).answer.then((response) => {
      if (!response) {
        throw new Error(`${method} timed out after ${timeoutMs}ms.`);
      }
      return response;
    });
  }
  async call(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number },
  ): Promise<unknown> {
    const response = await this.request(method, params, options.timeoutMs);
    if (!response.success) {
      throw Object.assign(new Error(this.redact(response.error ?? "Daemon refused request.")), {
        code: response.code,
      });
    }
    return response.result;
  }
}
export async function connectWithDeadline(
  connect: ConnectFrameSocket,
  path: string,
  timer: Timer,
  timeoutMs: number,
): Promise<FrameConnection> {
  let expired = false;
  try {
    return await raceWithDeadline(
      async () => {
        const connection = await connect(path);
        if (expired) {
          connection.destroy();
        }
        return connection;
      },
      { timer, timeoutMs, label: "frame socket connection" },
    );
  } finally {
    expired = true;
  }
}
export const connectFrameSocket: ConnectFrameSocket = (path) =>
  new Promise((done, reject) => {
    const socket = new Socket();
    // A connecting Unix socket has no exposed FrameConnection yet. Bound its
    // real transport lifetime too, so a deadline cannot leave a live handle.
    const deadline = defaultTimer.setTimeout(() => {
      socket.destroy(new Error("Frame socket connection timed out."));
    }, 30_000);
    socket.once("error", (error) => {
      defaultTimer.clearTimeout(deadline);
      reject(error);
    });
    socket.once("connect", () => {
      defaultTimer.clearTimeout(deadline);
      let closeError: Error | undefined;
      socket.on("error", (error) => {
        closeError = error;
      });
      done({
        write: (data) => {
          socket.write(data);
        },
        onData: (listener) => {
          socket.on("data", listener);
        },
        onClose: (listener) => {
          socket.on("close", () => listener(closeError));
        },
        end: () => {
          socket.end();
        },
        destroy: () => {
          socket.destroy();
        },
      });
    });
    socket.connect(path);
  });
export function classifyFrameMethod(
  method: string,
): "inventory" | "maintenance" | "mutation" | "none" {
  if (method === "daemon/refreshDevices") {
    return "inventory";
  }
  if (method.startsWith("ide/") && /restart|maintenance/i.test(method)) {
    return "maintenance";
  }
  return [
    "ide/setFeatureFlag",
    "ide/updateService",
    "ide/setKeyValue",
    "ide/removeKeyValue",
    "ide/clearKeyValueFile",
    "ide/republishIdentity",
  ].includes(method)
    ? "mutation"
    : "none";
}
// Immutable exported-method lookup: avoid re-enumerating the product module per frame.
// sessionInfo is registered as a literal, not an exported constant; our convenience pins it.
const knownDaemonMethods = new Set<unknown>([
  ...Object.entries(daemonConstants)
    .filter(([name]) => name.endsWith("_METHOD"))
    .map(([, value]) => value),
  "daemon/sessionInfo",
  "daemon/prepareSession",
  "daemon/sessionRequestStatus",
  "daemon/releaseBrokerSession",
  "daemon/abandonSessionRequest",
]);
export function daemonMethodHint(method: string): string | undefined {
  if (!/^(daemon|ide)\/.*-/.test(method)) {
    return undefined;
  }
  const camel = method.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return knownDaemonMethods.has(camel) ? `did you mean ${camel}?` : undefined;
}
function frameGuard(
  method: string,
  params: unknown,
  command: DaemonFrameCommand,
  ownSessionId?: string,
): string | undefined {
  if (
    command.brokerBinding &&
    (["resources", "resources/list"].includes(method) ||
      (["read", "resources/read"].includes(method) &&
        String((params as { uri?: unknown } | null)?.uri ?? "").startsWith("automobile:devices/")))
  ) {
    return "Device inventory resources are refused with --broker-binding.";
  }
  if (method === "tools/call") {
    const tool = params as { name?: string; arguments?: unknown } | null;
    let refusalProbe = false;
    if (
      command.brokerBinding &&
      ["startDevice", "provisionDevice", "getAndroid", "getApple", "killDevice"].includes(
        tool?.name ?? "",
      )
    ) {
      if (!command.expectRefused) {
        return `${tool?.name} is refused with --broker-binding; use --expect-refused to assert the product gate.`;
      }
      const args = tool?.arguments;
      if (
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        Object.entries(args).some(([key, value]) => key !== "sessionUuid" || value !== ownSessionId)
      ) {
        return "Expected lifecycle refusal requires {} or only this client's own sessionUuid; device names and selectors are forbidden.";
      }
      refusalProbe = true;
    }
    const refusal = deviceStartGuardRefusal(tool?.name ?? "", tool?.arguments, {
      // The strict probe shape above contains no native target or selector.
      allowSelector: command.allowSelector || refusalProbe,
    });
    if (refusal) {
      return refusal;
    }
  }
  return classifyFrameMethod(method) === "maintenance" && !command.allowHostMutation
    ? `${method} requires --allow-host-mutation; it can disrupt other agents' private daemon.`
    : undefined;
}
function frameNotice(method: string, deps: DaemonFrameDeps): void {
  const hint = daemonMethodHint(method);
  if (hint) {
    deps.err(hint);
  }
  const kind = classifyFrameMethod(method);
  if (kind === "inventory") {
    deps.err(`${method}: daemon inventory refresh; no device is booted or claimed.`);
  } else if (kind !== "none") {
    deps.err(
      `${method}: this frame can mutate host/device state outside a session; observing a refusal still sends it.`,
    );
  }
}
interface BrokerFrameBinding {
  config: SessionConfig;
  token: string;
  existingSessionId?: string;
  clients: Map<string, string>;
  frameToken?: string;
}
async function brokerKeeper(
  binding: BrokerFrameBinding,
  rpc: FrameRpc,
  deps: DaemonFrameDeps,
): Promise<{
  release(sendRelease?: boolean): Promise<void>;
  identity: BrokerFrameIdentity;
  ready: boolean;
}> {
  const { config, token } = binding;
  let heldSession: string | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const releaseSession = async (sessionId: string): Promise<unknown> => {
    // Binding to a live client's grant must never release it, including a failed hold.
    if (binding.existingSessionId) {
      return undefined;
    }
    return rpc.call(
      DAEMON_RELEASE_BROKER_SESSION_METHOD,
      { sessionId, livenessOwnerToken: token },
      { timeoutMs: BROKER_CLEANUP_TIMEOUT_MS },
    );
  };
  const release = async (sendRelease = true): Promise<void> => {
    if (heartbeat) {
      deps.timer.clearInterval(heartbeat);
    }
    if (!sendRelease || !heldSession) {
      return;
    }
    const sessionId = heldSession;
    heldSession = undefined;
    try {
      await releaseSession(sessionId);
    } catch (error) {
      deps.err(
        `Broker release failed; owner loss will release ${sessionId}: ${errorMessage(error)}`,
      );
    }
  };
  const leaseMs = readEnvPositiveInteger(
    "AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
    undefined,
    { fallback: DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS },
    deps.env,
    { warn: deps.err },
  );
  const heartbeatTimeoutMs = Math.max(
    1,
    Math.min(Math.floor(leaseMs / 2), PROXY_HEARTBEAT_INTERVAL_MS * 2),
  );
  const result = await acquireSessionThroughDaemon(config, {
    ensureConnected: async () => {
      rpc.assertOpen();
    },
    callDaemonMethod: (method, params, options) => rpc.call(method, params, options),
    livenessOwnerToken: token,
    timer: deps.timer,
    releaseSession,
    holdSession: async (_requestId, sessionId) => {
      if (binding.existingSessionId && binding.existingSessionId !== sessionId) {
        throw new Error("Broker grant differs from the client's recorded session.");
      }
      const params = {
        sessionId,
        livenessPolicy: HEARTBEAT_SESSION_LIVENESS_POLICY,
        livenessOwnerToken: token,
        reportIdleRelease: true,
        reportDaemonInstance: true,
      };
      await rpc.call(
        DAEMON_HEARTBEAT_METHOD,
        { ...params, claimLivenessOwnership: true },
        { timeoutMs: heartbeatTimeoutMs },
      );
      heldSession = sessionId;
      let inFlight = false;
      heartbeat = deps.timer.setInterval(() => {
        if (inFlight) {
          return;
        }
        inFlight = true;
        void rpc.call(DAEMON_HEARTBEAT_METHOD, params, { timeoutMs: heartbeatTimeoutMs }).then(
          () => {
            inFlight = false;
          },
          (error: unknown) => {
            inFlight = false;
            deps.err(`Broker heartbeat failed: ${errorMessage(error)}`);
            if (
              error !== null &&
              typeof error === "object" &&
              "code" in error &&
              error.code === DAEMON_SESSION_NOT_FOUND_CODE
            ) {
              if (heartbeat) {
                deps.timer.clearInterval(heartbeat);
              }
              heldSession = undefined;
            }
          },
        );
      }, PROXY_HEARTBEAT_INTERVAL_MS);
    },
  });
  deps.out(JSON.stringify(result));
  return {
    release,
    ready: result.outcome === "ready",
    identity: { sessionId: result.sessionUuid ?? undefined, token, clients: binding.clients },
  };
}
interface UserFrame {
  method: string;
  params: unknown;
}

function userFramesRefusal(
  frames: UserFrame[],
  command: DaemonFrameCommand,
  ownSessionId?: string,
): string | undefined {
  for (const frame of frames) {
    const refusal = frameGuard(frame.method, frame.params, command, ownSessionId);
    if (refusal) {
      return refusal;
    }
  }
  return undefined;
}
function readFrameBinding(
  command: DaemonFrameCommand,
  deps: DaemonFrameDeps,
  secrets: Set<string>,
): BrokerFrameBinding | undefined {
  if (!command.brokerBinding) {
    return undefined;
  }
  const source = command.brokerBinding;
  const batch = deps.env.MT_BATCH;
  const names = batch && isBrokerBatch(batch, deps) ? readBrokerClients(batch, deps) : [];
  const clients = new Map<string, string>();
  // Tokens from every initialized client are redacted even if a refusal echoes foreign input.
  for (const name of names) {
    const dir = resolve(batch!, "sessions", name);
    const tokenPath = join(dir, "owner-token");
    if (deps.exists(tokenPath)) {
      secrets.add(deps.readFile(tokenPath));
    }
    const initPath = join(dir, "init.json");
    if (deps.exists(initPath)) {
      const init = JSON.parse(deps.readFile(initPath)) as {
        session?: { outcome?: string; sessionUuid?: unknown };
      };
      if (
        init.session?.outcome === "ready" &&
        typeof init.session.sessionUuid === "string" &&
        init.session.sessionUuid
      ) {
        clients.set(name, init.session.sessionUuid);
      }
    }
  }
  const name = names.find(
    (client) =>
      source === client || resolve(source) === resolve(batch!, "sessions", client, "request.json"),
  );
  let binding: BrokerFrameBinding;
  if (name) {
    const client = resolveBrokerClient(batch, name, deps);
    const identity = readBrokerIdentity(client, deps);
    const sessionId = clients.get(name);
    if (!sessionId) {
      throw new Error("Client binding requires a recorded ready grant in init.json.");
    }
    binding = { ...identity, existingSessionId: sessionId, clients };
  } else {
    if (!source.endsWith("request.json")) {
      throw new Error("--broker-binding requires a batch client name or path to request.json.");
    }
    if (batch && isBrokerBatch(batch, deps)) {
      throw new Error(
        "Untracked broker batch acquisition refused; use --broker-binding <client> for a recorded batch client.",
      );
    }
    // Standalone acquisitions are permitted only outside broker batches.
    const token = deps.ids.next();
    secrets.add(token);
    binding = { config: parseSessionConfig(JSON.parse(deps.readFile(source))), token, clients };
    if (deps.exists(join(dirname(source), "owner-token"))) {
      throw new Error("Stored client requests must resolve to a client of MT_BATCH.");
    }
  }
  secrets.add(binding.token);
  if (command.tokenOf) {
    if (!name || command.tokenOf === name || !names.includes(command.tokenOf)) {
      throw new Error("--token-of must name another client of this binding's batch.");
    }
    const other = resolveBrokerClient(batch, command.tokenOf, deps);
    binding.frameToken = readBrokerIdentity(other, deps).token;
    secrets.add(binding.frameToken);
  }
  return binding;
}
function prepareUserFrames(
  command: DaemonFrameCommand,
  deps: DaemonFrameDeps,
  secrets: Set<string>,
): { frames: UserFrame[]; binding?: BrokerFrameBinding } | { error: string } {
  try {
    const binding = readFrameBinding(command, deps, secrets);
    const frames = [{ method: command.method, json: command.json }, ...command.then].map(
      (frame) => ({
        method: frame.method,
        params: JSON.parse(
          frame.json?.startsWith("@") ? deps.readFile(frame.json.slice(1)) : (frame.json ?? "{}"),
        ),
      }),
    );
    if (command.externalKeeper) {
      frames[0].params = {
        ...(frames[0].params as Record<string, unknown>),
        idleTimeoutMs: readEnvPositiveInteger(
          "AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
          "AUTO_MOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
          {
            fallback: DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS,
            min: DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS,
          },
          deps.env,
          { warn: deps.err },
        ),
      };
    }
    const planned = binding
      ? {
          sessionId: binding.existingSessionId ?? "{{ownSessionId}}",
          token: binding.token,
          clients: binding.clients,
        }
      : undefined;
    if (
      command.tokenOf &&
      frames.some(
        (frame) =>
          !["daemon/sessionRequestStatus", DAEMON_RELEASE_BROKER_SESSION_METHOD].includes(
            frame.method,
          ),
      )
    ) {
      throw new Error(
        "--token-of is only for sessionRequestStatus/releaseBrokerSession isolation frames.",
      );
    }
    const guardedFrames = frames.map((frame) => ({
      ...frame,
      params: substituteFramePlaceholders(frame.params, planned),
    }));
    const error = userFramesRefusal(guardedFrames, command, planned?.sessionId);
    return error ? { error } : { frames, binding };
  } catch (error) {
    deps.err(`Invalid JSON/config/placeholders: ${errorMessage(error)}`);
    return { error: "Invalid frame input; see diagnostic above." };
  }
}
function resolveUserFrames(
  frames: UserFrame[],
  identity: BrokerFrameIdentity,
  deps: DaemonFrameDeps,
): UserFrame[] | { error: string } {
  try {
    return frames.map((frame) => ({
      ...frame,
      params: substituteFramePlaceholders(frame.params, identity),
    }));
  } catch (error) {
    deps.err(`Cannot resolve broker frame: ${errorMessage(error)}`);
    // A failed acquisition may return no sessions; refuse all user frames before sending them.
    return { error: errorMessage(error) };
  }
}
function isProductRefusal(response: DaemonResponse): boolean {
  const envelope = response.result as
    | { isError?: boolean; content?: Array<{ type?: string; text?: string }> }
    | undefined;
  if (response.success !== false && envelope?.isError !== true) {
    return false;
  }
  const payload = readToolEnvelopePayload(response.result)?.payload;
  const code = response.code ?? payload?.code;
  if (
    typeof code === "string" &&
    ["device_outside_managed_slots", "session_ownership_lost"].includes(code)
  ) {
    return true;
  }
  const messages = [
    response.error,
    payload?.error,
    payload?.message,
    ...(Array.isArray(envelope?.content) ? envelope.content : [])
      .filter((part) => part?.type === "text")
      .map((part) => part.text),
  ];
  return messages.some(
    (message) =>
      typeof message === "string" &&
      (message.includes("Session request belongs to another liveness owner") ||
        /Session broker owns device lifecycle; \w+ cannot allocate or retire a device/.test(
          message,
        ) ||
        /Tool \w+ requires a live session granted by the session broker; prepare a session before using device tools/.test(
          message,
        )),
  );
}
async function sendUserFrames(
  command: DaemonFrameCommand,
  frames: UserFrame[],
  rpc: FrameRpc,
): Promise<number> {
  const first = frames[0];
  const responses = await Promise.all(
    Array.from({ length: command.count }, () =>
      rpc.request(first.method, first.params, command.timeoutMs, command.type),
    ),
  );
  for (const frame of frames.slice(1)) {
    responses.push(await rpc.request(frame.method, frame.params, command.timeoutMs, command.type));
  }
  if (command.holdMs > 0) {
    await rpc.pause(command.holdMs);
  }
  rpc.assertOpen();
  if (command.expectRefused) {
    return responses.every(isProductRefusal) ? 0 : 2;
  }
  return responses.every((response) => response.success === true) ? 0 : 1;
}
async function writeDestructiveFrames(
  command: DaemonFrameCommand,
  frame: UserFrame,
  rpc: FrameRpc,
  deps: DaemonFrameDeps,
): Promise<void> {
  for (let i = 0; i < command.count; i++) {
    rpc.connection.write(
      encodeDaemonFrame({
        id: deps.ids.next(),
        method: frame.method,
        params: frame.params,
        type: command.type,
        timeoutMs: command.timeoutMs,
      }),
    );
  }
  if (command.mode === "cancel-after") {
    await rpc.pause(command.cancelAfterMs!);
  }
}
async function finishFrameRun(
  rpc: FrameRpc | undefined,
  release: ((sendRelease?: boolean) => Promise<void>) | undefined,
  abrupt: boolean,
  deps: DaemonFrameDeps,
  cancellationSummary?: string,
): Promise<void> {
  if (release) {
    await release(!abrupt);
  }
  if (cancellationSummary) {
    deps.out(cancellationSummary);
  }
  if (rpc) {
    rpc.fail(new Error("Frame client finished."));
    if (!abrupt) {
      rpc.connection.end();
    }
  }
}
function privateFrameSocket(
  command: DaemonFrameCommand,
  deps: DaemonFrameDeps,
): { socket: string } | { error: string } {
  const env = privateClientEnvironment(deps.env, {});
  const socket = command.socket ?? env.AUTOMOBILE_DAEMON_SOCKET_PATH ?? "";
  const refusal =
    privateHarnessEnvRefusal(env, deps.host) ??
    privateHarnessEnvRefusal({ ...env, AUTOMOBILE_DAEMON_SOCKET_PATH: socket }, deps.host);
  return refusal || !isAbsolute(socket) || privatePathRefusal(socket, deps.host)
    ? { error: refusal ?? "Refusing non-absolute or resident socket." }
    : { socket };
}
export async function runDaemonFrame(
  command: DaemonFrameCommand,
  deps: DaemonFrameDeps,
): Promise<number> {
  const secrets = new Set<string>();
  const rawDeps = deps;
  const redact = (text: string): string => {
    for (const token of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
      text = text
        .replaceAll(JSON.stringify(token).slice(1, -1), "[REDACTED]")
        .replaceAll(token, "[REDACTED]");
    }
    return text;
  };
  deps = {
    ...deps,
    out: (line) => rawDeps.out(redact(line)),
    err: (line) => rawDeps.err(redact(line)),
  };
  const target = privateFrameSocket(command, deps);
  if ("error" in target) {
    deps.err(target.error);
    return 2;
  }
  const prepared = prepareUserFrames(command, deps, secrets);
  if ("error" in prepared) {
    deps.err(prepared.error);
    return 2;
  }
  let { frames } = prepared;
  let rpc: FrameRpc | undefined;
  let release: ((sendRelease?: boolean) => Promise<void>) | undefined;
  let abrupt = false;
  let cancellationSummary: string | undefined;
  let ownSessionId: string | undefined;
  try {
    const connection = await connectWithDeadline(
      deps.connect,
      target.socket,
      deps.timer,
      command.timeoutMs,
    );
    rpc = new FrameRpc(connection, deps, DAEMON_CLIENT_MAX_FRAME_BYTES, redact);
    if (prepared.binding) {
      const keeper = await brokerKeeper(prepared.binding, rpc, deps);
      release = keeper.release;
      ownSessionId = keeper.identity.sessionId;
      if (!keeper.ready) {
        return 1;
      }
      const resolved = resolveUserFrames(frames, keeper.identity, deps);
      if ("error" in resolved) {
        deps.err(resolved.error);
        return 2;
      }
      frames = resolved;
      if (prepared.binding.frameToken) {
        deps.err(`Isolation frame: using token of batch client ${command.tokenOf}.`);
        frames = frames.map((frame) => ({
          ...frame,
          params: {
            ...(frame.params as Record<string, unknown>),
            livenessOwnerToken: prepared.binding!.frameToken,
          },
        }));
      }
    }
    const refusal = userFramesRefusal(frames, command, ownSessionId);
    if (refusal) {
      deps.err(refusal);
      return 2;
    }
    for (const frame of frames) {
      frameNotice(frame.method, deps);
    }
    if (command.mode === "cancel-keep-open") {
      cancellationSummary = await cancelKeepOpen(command, frames[0], rpc, deps);
      return 0;
    }
    if (command.mode !== "send") {
      await writeDestructiveFrames(command, frames[0], rpc, deps);
      abrupt = true;
      connection.destroy();
      return 0;
    }
    return await sendUserFrames(command, frames, rpc);
  } catch (error) {
    deps.err(`Frame failed: ${errorMessage(error)}`);
    return 3;
  } finally {
    await finishFrameRun(rpc, release, abrupt, deps, cancellationSummary);
  }
}
async function cancelKeepOpen(
  command: DaemonFrameCommand,
  frame: { method: string; params: unknown },
  rpc: FrameRpc,
  deps: DaemonFrameDeps,
): Promise<string> {
  const delay = command.cancelAfterMs ?? 0;
  const requests = Array.from({ length: command.count }, () => {
    const { id, answer } = rpc.beginRequest(
      frame.method,
      frame.params,
      command.timeoutMs,
      command.type,
      delay + command.keepOpenMs,
    );
    // Install both handlers before constructing the next request, which may fail synchronously.
    const observed = answer.then(
      (response) => ({ id, response }),
      (error: unknown) => ({ id, error }),
    );
    return { id, observed };
  });
  if (delay > 0) {
    await rpc.pause(delay);
  }
  for (const { id } of requests) {
    rpc.connection.write(
      encodeDaemonFrame({
        id: deps.ids.next(),
        type: "daemon_request",
        method: DAEMON_CANCEL_REQUEST_METHOD,
        params: { requestId: id },
      }),
    );
  }
  const answers = await Promise.all(requests.map((request) => request.observed));
  const cancelled = answers.map((answer) => {
    if ("error" in answer) {
      throw answer.error;
    }
    const response = answer.response;
    return response
      ? { id: answer.id, answered: true, success: response.success, code: response.code }
      : { id: answer.id, answered: false };
  });
  rpc.assertOpen();
  return JSON.stringify({ cancelled });
}
export function frameHostDefaults(): HostDefaults {
  return {
    homeDirs: [homedir(), userInfo().homedir],
    uid: process.getuid?.() ?? userInfo().username,
    canonicalize: canonicalizeHostPath,
  };
}
export async function main(): Promise<number> {
  const parsed = parseDaemonFrameArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`${parsed.error}\nRun daemon-frame --help for usage.`);
    return 2;
  }
  if ("help" in parsed) {
    console.log(parsed.help);
    return 0;
  }
  return runDaemonFrame(parsed, {
    env: process.env,
    host: frameHostDefaults(),
    connect: connectFrameSocket,
    timer: defaultTimer,
    ids: defaultIdGenerator,
    readFile: (path) => readFileSync(path, "utf8"),
    exists: existsSync,
    out: console.log,
    err: console.error,
  });
}
if (import.meta.main) {
  process.exitCode = await main();
}
