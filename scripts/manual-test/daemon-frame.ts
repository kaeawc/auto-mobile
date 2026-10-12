#!/usr/bin/env bun
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

const usage = `Usage: daemon-frame send <method> ['<params json>'|@file]
  [--socket PATH] [--type mcp_request|daemon_request] [--count N] [--timeout-ms N]
  [--mode send|cancel|cancel-after:<ms>] [--managed-binding CONFIG] [--hold-ms N]
  [--allow-selector] [--allow-host-mutation]
--managed-binding ACQUIRES real slots and can create/boot amslot-* devices.
Use a runner namespace no live proxy is using. All frames use that SAME connection.
Restart/maintenance methods require --allow-host-mutation. Cancel modes destroy the socket;
managed sessions then end through owner loss, rather than an explicit release.
Exit codes: 0 success/cancel, 1 typed refusal, 2 usage/guard, 3 timeout/connection error.`;
export interface DaemonFrameCommand {
  method: string;
  json?: string;
  socket?: string;
  type?: DaemonRequest["type"];
  count: number;
  timeoutMs: number;
  mode: "send" | "cancel" | "cancel-after";
  cancelAfterMs?: number;
  managedBinding?: string;
  holdMs: number;
  allowSelector: boolean;
  allowHostMutation: boolean;
}
export function parseDaemonFrameArgs(argv: string[]): DaemonFrameCommand | { error: string } {
  if (argv[0] !== "send" || !argv[1] || argv[1].startsWith("--")) {
    return { error: usage };
  }
  const command: DaemonFrameCommand = {
    method: argv[1],
    count: 1,
    timeoutMs: 30_000,
    mode: "send",
    holdMs: 0,
    allowSelector: false,
    allowHostMutation: false,
  };
  const values: Record<string, string> = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--allow-selector" || flag === "--allow-host-mutation") {
      if (flag === "--allow-selector") {
        command.allowSelector = true;
      } else {
        command.allowHostMutation = true;
      }
      continue;
    }
    if (!flag.startsWith("--") && command.json === undefined) {
      command.json = flag;
      continue;
    }
    if (
      ![
        "--socket",
        "--type",
        "--count",
        "--timeout-ms",
        "--mode",
        "--managed-binding",
        "--hold-ms",
      ].includes(flag)
    ) {
      return { error: `Unknown argument ${flag}.\n${usage}` };
    }
    const value = argv[++i];
    if (!value || value.startsWith("--") || values[flag] !== undefined) {
      return { error: `Missing/duplicate value for ${flag}.` };
    }
    values[flag] = value;
  }
  for (const [flag, field, minimum] of [
    ["--count", "count", 1],
    ["--timeout-ms", "timeoutMs", 1],
    ["--hold-ms", "holdMs", 0],
  ] as const) {
    if (values[flag] !== undefined) {
      const value = Number(values[flag]);
      if (
        !/^\d+$/.test(values[flag]) ||
        !Number.isSafeInteger(value) ||
        value < minimum ||
        value > MAX_SETTIMEOUT_DELAY_MS
      ) {
        return {
          error: `${flag} must be an integer from ${minimum} to ${MAX_SETTIMEOUT_DELAY_MS}.`,
        };
      }
      command[field] = value;
    }
  }
  const type = values["--type"];
  if (type !== undefined && type !== "mcp_request" && type !== "daemon_request") {
    return { error: "Invalid --type." };
  }
  command.type = type;
  command.socket = values["--socket"];
  command.managedBinding = values["--managed-binding"];
  const mode = values["--mode"] ?? "send";
  if (mode === "send" || mode === "cancel") {
    command.mode = mode;
  } else if (/^cancel-after:\d+$/.test(mode)) {
    const delay = Number(mode.slice("cancel-after:".length));
    if (!Number.isSafeInteger(delay) || delay > MAX_SETTIMEOUT_DELAY_MS) {
      return { error: "Invalid cancel-after delay." };
    }
    command.mode = "cancel-after";
    command.cancelAfterMs = delay;
  } else {
    return { error: "Invalid --mode; use send, cancel or cancel-after:<ms>." };
  }
  return command;
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
    { done(response: DaemonResponse): void; reject(error: Error): void; timeout: NodeJS.Timeout }
  >();
  private failure?: Error;
  private pauses = new Set<(error: Error) => void>();
  private decoder = new LineDecoder();
  private startedAt: number;
  constructor(
    readonly connection: FrameConnection,
    private readonly deps: Pick<DaemonFrameDeps, "timer" | "ids" | "out">,
  ) {
    this.startedAt = deps.timer.now();
    connection.onData((chunk) => {
      for (const line of this.decoder.push(chunk)) {
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
  request(
    method: string,
    params: unknown,
    timeoutMs: number,
    type?: DaemonRequest["type"],
  ): Promise<DaemonResponse> {
    this.assertOpen();
    const id = this.deps.ids.next();
    return new Promise((done, reject) => {
      const timeout = this.deps.timer.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { done, reject, timeout });
      try {
        this.connection.write(encodeDaemonFrame({ id, method, params, timeoutMs, type }));
      } catch (error) {
        this.fail(new Error(`Control write failed: ${errorMessage(error)}`));
      }
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
function hostMaintenance(method: string): boolean {
  // All currently registered restart/maintenance admission, commit and release routes.
  return method.startsWith("ide/") && /restart|maintenance/i.test(method);
}
function mutationNotice(method: string): boolean {
  return (
    method === "daemon/refreshDevices" ||
    method === "ide/setFeatureFlag" ||
    hostMaintenance(method) ||
    [
      "ide/updateService",
      "ide/setKeyValue",
      "ide/removeKeyValue",
      "ide/clearKeyValueFile",
      "ide/republishIdentity",
    ].includes(method)
  );
}
async function managedKeeper(
  config: ReturnType<typeof parseManagedSlotConfigSource>,
  rpc: FrameRpc,
  deps: DaemonFrameDeps,
): Promise<(sendRelease?: boolean) => Promise<void>> {
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
  return release;
}
export async function runDaemonFrame(
  command: DaemonFrameCommand,
  deps: DaemonFrameDeps,
): Promise<number> {
  const env = privateClientEnvironment(deps.env, {});
  const socket = command.socket ?? env.AUTOMOBILE_DAEMON_SOCKET_PATH ?? "";
  const refusal =
    privateHarnessEnvRefusal(env, deps.host) ??
    privateHarnessEnvRefusal({ ...env, AUTOMOBILE_DAEMON_SOCKET_PATH: socket }, deps.host);
  if (refusal || !isAbsolute(socket) || privatePathRefusal(socket, deps.host)) {
    deps.err(refusal ?? "Refusing non-absolute or resident socket.");
    return 2;
  }
  let params: unknown;
  let config: ReturnType<typeof parseManagedSlotConfigSource> | undefined;
  try {
    params = JSON.parse(
      command.json?.startsWith("@") ? deps.readFile(command.json.slice(1)) : (command.json ?? "{}"),
    );
    config =
      command.managedBinding === undefined
        ? undefined
        : parseManagedSlotConfigSource(command.managedBinding, deps.readFile);
  } catch (error) {
    deps.err(`Invalid JSON/config: ${errorMessage(error)}`);
    return 2;
  }
  if (command.method === "tools/call") {
    const tool = params as { name?: string; arguments?: unknown } | null;
    const guard = deviceStartGuardRefusal(tool?.name ?? "", tool?.arguments, {
      allowSelector: command.allowSelector,
    });
    if (guard) {
      deps.err(guard);
      return 2;
    }
  }
  if (mutationNotice(command.method)) {
    deps.err(
      `${command.method}: this frame can mutate host/device state outside a session; observing a refusal still sends it.`,
    );
  }
  if (hostMaintenance(command.method) && !command.allowHostMutation) {
    deps.err(
      `${command.method} requires --allow-host-mutation; it can disrupt other agents' private daemon.`,
    );
    return 2;
  }
  let rpc: FrameRpc | undefined;
  let release: ((sendRelease?: boolean) => Promise<void>) | undefined;
  let abrupt = false;
  try {
    const connection = await connectWithDeadline(
      deps.connect,
      socket,
      deps.timer,
      command.timeoutMs,
    );
    rpc = new FrameRpc(connection, deps);
    if (config) {
      release = await managedKeeper(config, rpc, deps);
    }
    if (command.mode !== "send") {
      for (let i = 0; i < command.count; i++) {
        connection.write(
          encodeDaemonFrame({
            id: deps.ids.next(),
            method: command.method,
            params,
            type: command.type,
            timeoutMs: command.timeoutMs,
          }),
        );
      }
      if (command.mode === "cancel-after") {
        await rpc.pause(command.cancelAfterMs!);
      }
      abrupt = true;
      connection.destroy();
      return 0;
    }
    const responses = await Promise.all(
      Array.from({ length: command.count }, () =>
        rpc!.request(command.method, params, command.timeoutMs, command.type),
      ),
    );
    if (command.holdMs > 0) {
      await rpc.pause(command.holdMs);
    }
    rpc.assertOpen();
    return responses.every((response) => response.success === true) ? 0 : 1;
  } catch (error) {
    deps.err(`Frame failed: ${errorMessage(error)}`);
    return 3;
  } finally {
    if (release) {
      await release(!abrupt);
    }
    if (rpc) {
      rpc.fail(new Error("Frame client finished."));
      if (!abrupt) {
        rpc.connection.end();
      }
    }
  }
}
export function frameHostDefaults(): HostDefaults {
  return {
    homeDirs: [homedir(), userInfo().homedir],
    uid: process.getuid?.() ?? userInfo().username,
    canonicalize: canonicalizeHostPath,
  };
}
export async function main(): Promise<number> {
  if (process.argv[2] === "--help") {
    console.log(usage);
    return 0;
  }
  const parsed = parseDaemonFrameArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
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
