#!/usr/bin/env bun
import "./harnessLogSink";
import { DAEMON_CLIENT_MAX_FRAME_BYTES } from "../../src/daemon/socketServer/LineFramer";
import * as daemonConstants from "../../src/daemon/constants";
import { DAEMON_FRAME_COMMANDS, DAEMON_FRAME_FLAGS, daemonFrameHelp } from "./daemonFrameHelp";
import { substituteFramePlaceholders, type ManagedFrameIdentity } from "./daemonFramePlaceholders";
import { readFileSync } from "node:fs";
import { Socket } from "node:net";
import { homedir, userInfo } from "node:os";
import { isAbsolute } from "node:path";
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
  DAEMON_RELEASE_EXECUTION_METHOD,
  HEARTBEAT_SESSION_LIVENESS_POLICY,
} from "../../src/daemon/constants";
import { acquireManagedSlotsThroughDaemon } from "../../src/daemon/managedSlotProxyAcquisition";
import { MANAGED_EXECUTION_RELEASE_TIMEOUT_MS } from "../../src/daemon/managedExecutionLiveness";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  PROXY_HEARTBEAT_INTERVAL_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { parseManagedSlotConfigSource } from "../../src/models/managedSlotConfig";
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
  managedBinding?: string;
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
  command.managedBinding = values["--managed-binding"];
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
      throw Object.assign(new Error(response.error ?? "Daemon refused request."), {
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
): string | undefined {
  if (method === "tools/call") {
    const tool = params as { name?: string; arguments?: unknown } | null;
    const refusal = deviceStartGuardRefusal(tool?.name ?? "", tool?.arguments, {
      allowSelector: command.allowSelector,
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
async function managedKeeper(
  config: ReturnType<typeof parseManagedSlotConfigSource>,
  rpc: FrameRpc,
  deps: DaemonFrameDeps,
): Promise<{ release(sendRelease?: boolean): Promise<void>; identity: ManagedFrameIdentity }> {
  const token = deps.ids.next();
  const held = new Map<string, NodeJS.Timeout | undefined>();
  const options = { timeoutMs: MANAGED_EXECUTION_RELEASE_TIMEOUT_MS };
  const leaseMs = readEnvPositiveInteger(
    "AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
    undefined,
    { fallback: DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS },
    deps.env,
    { warn: deps.err },
  );
  // Same per-heartbeat deadline as DaemonMcpProxy, independent of its lifecycle machinery.
  const heartbeatTimeoutMs = Math.max(
    1,
    Math.min(Math.floor(leaseMs / 2), PROXY_HEARTBEAT_INTERVAL_MS * 2),
  );
  const release = async (sendRelease = true): Promise<void> => {
    const sessions = [...held.keys()];
    for (const handle of held.values()) {
      if (handle) {
        deps.timer.clearInterval(handle);
      }
    }
    held.clear();
    if (!sendRelease) {
      return;
    }
    await Promise.all(
      sessions.map(async (sessionId) => {
        try {
          await rpc.call(
            DAEMON_RELEASE_EXECUTION_METHOD,
            { sessionId, livenessOwnerToken: token },
            options,
          );
        } catch (error) {
          // A typed missing session has already completed release; other failures remain visible.
          if (
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === DAEMON_SESSION_NOT_FOUND_CODE
          ) {
            return;
          }
          deps.err(
            `Managed release failed; owner loss will release ${sessionId}: ${errorMessage(error)}`,
          );
        }
      }),
    );
  };
  const result = await acquireManagedSlotsThroughDaemon(config, {
    ensureConnected: async () => {
      rpc.assertOpen();
    },
    callDaemonMethod: (method, params, requestOptions) => rpc.call(method, params, requestOptions),
    livenessOwnerToken: token,
    timer: deps.timer,
    releaseHeldSessions: release,
    holdSession: async (sessionId) => {
      const params = {
        sessionId,
        livenessPolicy: HEARTBEAT_SESSION_LIVENESS_POLICY,
        livenessOwnerToken: token,
        reportIdleRelease: true,
        reportDaemonInstance: true,
      };
      // The proxy does NOT send livenessOwnerKind; it sends the heartbeat policy,
      // which the daemon preserves as managed-execution for slot sessions.
      held.set(sessionId, undefined);
      await rpc.call(
        DAEMON_HEARTBEAT_METHOD,
        { ...params, claimLivenessOwnership: true },
        { timeoutMs: heartbeatTimeoutMs },
      );
      let inFlight = false;
      const handle = deps.timer.setInterval(() => {
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
            deps.err(`Managed heartbeat failed: ${errorMessage(error)}`);
            // A typed not-found answer ends this session's keeper; transient misses do not
            // abort the shared connection or its user frames (as for proxy held sessions).
            if (
              error !== null &&
              typeof error === "object" &&
              "code" in error &&
              error.code === DAEMON_SESSION_NOT_FOUND_CODE
            ) {
              deps.timer.clearInterval(handle);
              held.delete(sessionId);
            }
          },
        );
      }, PROXY_HEARTBEAT_INTERVAL_MS);
      held.set(sessionId, handle);
    },
  });
  deps.out(JSON.stringify(result));
  const sessionIds = result.slots.flatMap((slot) => (slot.sessionUuid ? [slot.sessionUuid] : []));
  const slots = new Map(
    result.slots.flatMap((slot) =>
      slot.sessionUuid ? [[slot.slotIndex, slot.sessionUuid] as const] : [],
    ),
  );
  return { release, identity: { sessionIds, slots, token } };
}
interface UserFrame {
  method: string;
  params: unknown;
}
type ManagedFrameConfig = ReturnType<typeof parseManagedSlotConfigSource>;
function userFramesRefusal(frames: UserFrame[], command: DaemonFrameCommand): string | undefined {
  for (const frame of frames) {
    const refusal = frameGuard(frame.method, frame.params, command);
    if (refusal) {
      return refusal;
    }
  }
  return undefined;
}
function prepareUserFrames(
  command: DaemonFrameCommand,
  deps: DaemonFrameDeps,
): { frames: UserFrame[]; config?: ManagedFrameConfig } | { error: string } {
  try {
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
    const config =
      command.managedBinding === undefined
        ? undefined
        : parseManagedSlotConfigSource(command.managedBinding, deps.readFile);
    // Validate names and requested slot indices before connecting or acquiring anything.
    const planned = config
      ? {
          sessionIds: ["planned-session"],
          slots: new Map(config.requests.map((slot) => [slot.slotIndex, "planned-session"])),
          token: "planned-token",
        }
      : undefined;
    for (const frame of frames) {
      substituteFramePlaceholders(frame.params, planned);
    }
    const error = userFramesRefusal(frames, command);
    return error ? { error } : { frames, config };
  } catch (error) {
    return { error: `Invalid JSON/config/placeholders: ${errorMessage(error)}` };
  }
}
function resolveUserFrames(
  frames: UserFrame[],
  identity: ManagedFrameIdentity,
): UserFrame[] | { error: string } {
  try {
    return frames.map((frame) => ({
      ...frame,
      params: substituteFramePlaceholders(frame.params, identity),
    }));
  } catch (error) {
    // A failed acquisition may return no sessions; refuse all user frames before sending them.
    return { error: errorMessage(error) };
  }
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
  const target = privateFrameSocket(command, deps);
  if ("error" in target) {
    deps.err(target.error);
    return 2;
  }
  const prepared = prepareUserFrames(command, deps);
  if ("error" in prepared) {
    deps.err(prepared.error);
    return 2;
  }
  let { frames } = prepared;
  let rpc: FrameRpc | undefined;
  let release: ((sendRelease?: boolean) => Promise<void>) | undefined;
  let abrupt = false;
  let cancellationSummary: string | undefined;
  try {
    const connection = await connectWithDeadline(
      deps.connect,
      target.socket,
      deps.timer,
      command.timeoutMs,
    );
    rpc = new FrameRpc(connection, deps);
    if (prepared.config) {
      const keeper = await managedKeeper(prepared.config, rpc, deps);
      release = keeper.release;
      const resolved = resolveUserFrames(frames, keeper.identity);
      if ("error" in resolved) {
        deps.err(resolved.error);
        return 2;
      }
      frames = resolved;
    }
    const refusal = userFramesRefusal(frames, command);
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
    out: console.log,
    err: console.error,
  });
}
if (import.meta.main) {
  process.exitCode = await main();
}
