#!/usr/bin/env bun
import { basename, join, isAbsolute } from "node:path";
import {
  TEST_RECORDING_SOCKET_CONFIG,
  VIDEO_STREAM_SOCKET_CONFIG,
  resolveWebRtcStreamSocketPath,
} from "../../src/daemon/daemonFiles";
import { resolveAuxSocketDir } from "../../src/daemon/socketServer/SocketServerTypes";
import {
  DAEMON_REGISTER_SESSION_METHOD,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_RELEASE_SESSION_METHOD,
} from "../../src/daemon/constants";
import type {
  TestRecordingCommand,
  TestRecordingResponse,
} from "../../src/daemon/testRecordingSocketTypes";
import type {
  VideoStreamSocketRequest,
  VideoStreamSocketResponse,
} from "../../src/daemon/videoStreamSocketTypes";
import type { WebRtcStreamSocketRequest } from "../../src/daemon/webrtcStreamSocketTypes";
import { sendWebRtcStreamRequest } from "../../src/daemon/webrtcStreamClient";
import { defaultTimer, MAX_SETTIMEOUT_DELAY_MS, type Timer } from "../../src/utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../../src/utils/IdGenerator";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { privateHarnessEnvRefusal } from "./harnessEnv";
import {
  privatePathRefusal,
  privateClientEnvironment,
  type HostDefaults,
} from "./privateDaemonEnv";
import {
  FrameRpc,
  connectWithDeadline,
  connectFrameSocket,
  frameHostDefaults,
} from "./daemon-frame";
import {
  encodeJsonLine,
  LineDecoder,
  type ConnectFrameSocket,
  type FrameConnection,
} from "./frameWire";

const usage = `Usage: aux-socket recording <start|stop|status> [--device-id D] [--platform android|ios] [--recording-id R] [--plan-name N]
  aux-socket video '<subscribe json>' [--hold-ms N]
  aux-socket webrtc <start|stop|status|list|await> ['<request json>'] [--timeout-ms N]
Common: [--session-uuid U | --observer] [--observer-name N] [--heartbeat-ms N]
Requires the private harness env. Observer sessions register and heartbeat on its control socket,
then release on exit. Video reports bytes only (the product exports no packet decoder).
Exit codes: 0 success, 1 typed refusal, 2 usage/guard, 3 timeout/connection error.`;
export interface AuxSocketCommand {
  kind: "recording" | "video" | "webrtc";
  request: TestRecordingCommand | VideoStreamSocketRequest | WebRtcStreamSocketRequest;
  observer: boolean;
  observerName: string;
  heartbeatMs: number;
  holdMs: number;
  timeoutMs: number;
}
function jsonRequest(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request JSON must be an object.");
  }
  return parsed as Record<string, unknown>;
}
export function parseAuxSocketArgs(argv: string[]): AuxSocketCommand | { error: string } {
  const [kind, action] = argv;
  if (kind !== "recording" && kind !== "video" && kind !== "webrtc") {
    return { error: usage };
  }
  let request: AuxSocketCommand["request"];
  let index = 2;
  try {
    if (kind === "video") {
      const value = jsonRequest(action);
      if (value.action !== "subscribe") {
        return { error: "video requires a subscribe JSON object." };
      }
      request = value as unknown as VideoStreamSocketRequest;
    } else if (kind === "recording") {
      if (action !== "start" && action !== "stop" && action !== "status") {
        return { error: usage };
      }
      request = { command: action };
    } else {
      if (
        action !== "start" &&
        action !== "stop" &&
        action !== "status" &&
        action !== "list" &&
        action !== "await"
      ) {
        return { error: usage };
      }
      const value = argv[index] && !argv[index].startsWith("--") ? jsonRequest(argv[index++]) : {};
      request = { ...value, action };
      if (
        action === "start" &&
        (typeof request.whipEndpoint !== "string" || !request.whipEndpoint.trim())
      ) {
        return { error: "webrtc start requires whipEndpoint in request JSON." };
      }
    }
  } catch (error) {
    return { error: `Invalid request: ${errorMessage(error)}` };
  }
  const values: Record<string, string> = {};
  const command: AuxSocketCommand = {
    kind,
    request,
    observer: false,
    observerName: "manual-test-observer",
    heartbeatMs: 2000,
    holdMs: 5000,
    timeoutMs: 45_000,
  };
  const common = ["--session-uuid", "--observer-name", "--heartbeat-ms"];
  const allowed = [
    ...common,
    ...(kind === "recording"
      ? ["--device-id", "--platform", "--recording-id", "--plan-name"]
      : kind === "video"
        ? ["--hold-ms"]
        : ["--timeout-ms"]),
  ];
  for (let i = index; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--observer") {
      command.observer = true;
      continue;
    }
    if (!allowed.includes(flag)) {
      return { error: `Unknown argument ${flag}.` };
    }
    const value = argv[++i];
    if (!value || value.startsWith("--") || values[flag] !== undefined) {
      return { error: `Missing/duplicate value for ${flag}.` };
    }
    values[flag] = value;
  }
  if (
    command.observer &&
    (values["--session-uuid"] !== undefined || request.sessionUuid !== undefined)
  ) {
    return { error: "--observer and sessionUuid are mutually exclusive." };
  }
  for (const [flag, field, min] of [
    ["--heartbeat-ms", "heartbeatMs", 1],
    ["--hold-ms", "holdMs", 0],
    ["--timeout-ms", "timeoutMs", 1],
  ] as const) {
    if (values[flag] !== undefined) {
      const value = Number(values[flag]);
      if (
        !/^\d+$/.test(values[flag]) ||
        !Number.isSafeInteger(value) ||
        value < min ||
        value > MAX_SETTIMEOUT_DELAY_MS
      ) {
        return { error: `${flag} must be an integer from ${min} to ${MAX_SETTIMEOUT_DELAY_MS}.` };
      }
      command[field] = value;
    }
  }
  if (
    values["--platform"] &&
    values["--platform"] !== "android" &&
    values["--platform"] !== "ios"
  ) {
    return { error: "Invalid --platform." };
  }
  if (values["--session-uuid"]) {
    request.sessionUuid = values["--session-uuid"];
  }
  command.observerName = values["--observer-name"] ?? command.observerName;
  if (kind === "recording") {
    Object.assign(
      request,
      Object.fromEntries(
        [
          ["--device-id", "deviceId"],
          ["--platform", "platform"],
          ["--recording-id", "recordingId"],
          ["--plan-name", "planName"],
        ].flatMap(([flag, field]) => (values[flag] === undefined ? [] : [[field, values[flag]]])),
      ),
    );
  }
  return command;
}
export interface AuxSocketDeps {
  env: Record<string, string | undefined>;
  host: HostDefaults;
  connect: ConnectFrameSocket;
  sendWebRtc: typeof sendWebRtcStreamRequest;
  timer: Timer;
  ids: IdGenerator;
  out(line: string): void;
  err(line: string): void;
}
async function recording(
  connection: FrameConnection,
  request: TestRecordingCommand,
  deps: AuxSocketDeps,
  timeoutMs: number,
): Promise<number> {
  return new Promise((done, reject) => {
    const decoder = new LineDecoder();
    let settled = false;
    const finish = (error?: Error, code = 0): void => {
      if (settled) {
        return;
      }
      settled = true;
      deps.timer.clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        done(code);
      }
    };
    const timeout = deps.timer.setTimeout(
      () => finish(new Error("Recording response timed out.")),
      timeoutMs,
    );
    connection.onClose((error) =>
      finish(error ?? new Error("Recording socket closed before response.")),
    );
    connection.onData((chunk) => {
      const [line] = decoder.push(chunk, 1);
      if (line === undefined || settled) {
        return;
      }
      deps.out(line);
      try {
        const response: TestRecordingResponse = JSON.parse(line);
        finish(undefined, response.success === true ? 0 : 1);
      } catch (error) {
        finish(new Error(`Invalid recording response: ${errorMessage(error)}`));
      }
    });
    try {
      connection.write(encodeJsonLine(request));
    } catch (error) {
      finish(new Error(`Recording write failed: ${errorMessage(error)}`));
    }
  });
}
async function video(
  connection: FrameConnection,
  request: VideoStreamSocketRequest,
  command: AuxSocketCommand,
  deps: AuxSocketDeps,
): Promise<number> {
  return new Promise((done, reject) => {
    const decoder = new LineDecoder();
    let ack: VideoStreamSocketResponse | undefined;
    let bytesAfterAck = 0;
    let settled = false;
    let hold: NodeJS.Timeout | undefined;
    const finish = (closedBy: "hold" | "server", error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      deps.timer.clearTimeout(timeout);
      if (hold) {
        deps.timer.clearTimeout(hold);
      }
      if (error) {
        reject(error);
        return;
      }
      if (!ack) {
        reject(new Error("Video socket closed before acknowledgement."));
        return;
      }
      deps.out(JSON.stringify({ ack, bytesAfterAck, closedBy }));
      done(ack.success === true ? 0 : 1);
    };
    const timeout = deps.timer.setTimeout(
      () => finish("server", new Error("Video acknowledgement timed out.")),
      command.timeoutMs,
    );
    connection.onClose((error) => finish("server", error));
    connection.onData((chunk) => {
      if (settled) {
        return;
      }
      if (ack) {
        bytesAfterAck += chunk.length;
        return;
      }
      const [line] = decoder.push(chunk, 1);
      if (line === undefined) {
        return;
      }
      deps.out(line);
      try {
        ack = JSON.parse(line) as VideoStreamSocketResponse;
        bytesAfterAck += decoder.remainder().length;
        deps.timer.clearTimeout(timeout);
        if (ack.success !== true) {
          finish("server");
          return;
        }
        hold = deps.timer.setTimeout(() => finish("hold"), command.holdMs);
      } catch (error) {
        finish("server", new Error(`Invalid video ack: ${errorMessage(error)}`));
      }
    });
    try {
      connection.write(encodeJsonLine(request));
    } catch (error) {
      finish("server", new Error(`Video write failed: ${errorMessage(error)}`));
    }
  });
}
export async function runAuxSocket(
  command: AuxSocketCommand,
  deps: AuxSocketDeps,
): Promise<number> {
  // Match the proxy's sanitized client environment (inherited WebRTC path overrides are cleared).
  const env = privateClientEnvironment(deps.env, {});
  const refusal = privateHarnessEnvRefusal(env, deps.host);
  if (refusal) {
    deps.err(refusal);
    return 2;
  }
  const socket =
    command.kind === "webrtc"
      ? resolveWebRtcStreamSocketPath(env)
      : join(
          resolveAuxSocketDir(env),
          basename(
            (command.kind === "video" ? VIDEO_STREAM_SOCKET_CONFIG : TEST_RECORDING_SOCKET_CONFIG)
              .defaultPath,
          ),
        );
  const socketRefusal = privatePathRefusal(socket, deps.host);
  if (!isAbsolute(socket) || socketRefusal) {
    deps.err(socketRefusal ?? "Aux socket path must be absolute.");
    return 2;
  }
  if (command.observer && command.request.sessionUuid !== undefined) {
    deps.err("--observer and sessionUuid are mutually exclusive.");
    return 2;
  }
  const request = { ...command.request };
  let control: FrameRpc | undefined;
  let connection: FrameConnection | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let registered: string | undefined;
  try {
    if (command.observer) {
      control = new FrameRpc(
        await connectWithDeadline(
          deps.connect,
          env.AUTOMOBILE_DAEMON_SOCKET_PATH!,
          deps.timer,
          command.timeoutMs,
        ),
        deps,
      );
      const sessionId = deps.ids.next();
      const reply = await control.request(
        DAEMON_REGISTER_SESSION_METHOD,
        { sessionId, clientName: command.observerName },
        command.timeoutMs,
      );
      const registration = reply.result as
        | { accepted?: boolean; heartbeatTimeoutMs?: number }
        | undefined;
      if (!reply.success || !registration?.accepted) {
        return 1;
      }
      registered = sessionId;
      if (
        typeof registration.heartbeatTimeoutMs !== "number" ||
        command.heartbeatMs >= registration.heartbeatTimeoutMs
      ) {
        deps.err("--heartbeat-ms must be below registration heartbeatTimeoutMs.");
        return 2;
      }
      request.sessionUuid = sessionId;
      let pending = false;
      heartbeat = deps.timer.setInterval(() => {
        if (pending) {
          return;
        }
        pending = true;
        void control!
          .call(DAEMON_HEARTBEAT_METHOD, { sessionId }, { timeoutMs: command.heartbeatMs })
          .then(
            () => {
              pending = false;
            },
            (error: unknown) => {
              pending = false;
              deps.err(`Observer heartbeat failed: ${errorMessage(error)}`);
              control!.fail(new Error(errorMessage(error)));
              connection?.destroy();
            },
          );
      }, command.heartbeatMs);
    }
    let code: number;
    if (command.kind === "webrtc") {
      const response = await deps.sendWebRtc(request as WebRtcStreamSocketRequest, {
        socketPath: socket,
        timeoutMs: command.timeoutMs,
        timer: deps.timer,
      });
      deps.out(JSON.stringify(response));
      code = response.success === true ? 0 : 1;
    } else {
      connection = await connectWithDeadline(deps.connect, socket, deps.timer, command.timeoutMs);
      code =
        command.kind === "recording"
          ? await recording(connection, request as TestRecordingCommand, deps, command.timeoutMs)
          : await video(connection, request as VideoStreamSocketRequest, command, deps);
    }
    control?.assertOpen();
    return code;
  } catch (error) {
    deps.err(`Aux request failed: ${errorMessage(error)}`);
    return 3;
  } finally {
    if (heartbeat) {
      deps.timer.clearInterval(heartbeat);
    }
    connection?.end();
    if (control) {
      if (registered) {
        try {
          await control.call(
            DAEMON_RELEASE_SESSION_METHOD,
            { sessionId: registered },
            { timeoutMs: command.timeoutMs },
          );
        } catch (error) {
          deps.err(`Observer release failed: ${errorMessage(error)}`);
        }
      }
      control.fail(new Error("Observer finished."));
      control.connection.end();
    }
  }
}
export async function main(): Promise<number> {
  if (process.argv[2] === "--help") {
    console.log(usage);
    return 0;
  }
  const parsed = parseAuxSocketArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }
  return runAuxSocket(parsed, {
    env: process.env,
    host: frameHostDefaults(),
    connect: connectFrameSocket,
    sendWebRtc: sendWebRtcStreamRequest,
    timer: defaultTimer,
    ids: defaultIdGenerator,
    out: console.log,
    err: console.error,
  });
}
if (import.meta.main) {
  process.exitCode = await main();
}
