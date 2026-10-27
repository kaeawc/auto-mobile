#!/usr/bin/env bun
import "./harnessLogSink";
import {
  AUX_SOCKET_MAX_FRAME_BYTES,
  FAILURES_STREAM_MAX_FRAME_BYTES,
} from "../../src/daemon/wire/LineFramer";
import { basename, join, isAbsolute } from "node:path";
import {
  DEVICE_GESTURE_RECORDING_SOCKET_CONFIG,
  VIDEO_STREAM_SOCKET_CONFIG,
  resolveWebRtcStreamSocketPath,
} from "../../src/daemon/daemonFiles";
import { resolveAuxSocketDir } from "../../src/daemon/socketServer/SocketServerTypes";
import {
  DAEMON_REGISTER_SESSION_METHOD,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_RELEASE_SESSION_METHOD,
} from "../../src/daemon/wire/constants";
import type {
  DeviceGestureRecordingCommand,
  DeviceGestureRecordingResponse,
} from "../../src/daemon/deviceGestureRecordingSocketTypes";
import type {
  VideoStreamSocketRequest,
  VideoStreamSocketResponse,
} from "../../src/daemon/wire/videoStreamSocketTypes";
import type { WebRtcStreamSocketRequest } from "../../src/daemon/webrtcStreamSocketTypes";
import { sendWebRtcStreamRequest } from "../lib/webrtcStreamClient";
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

import {
  AUX_SOCKET_COMMANDS,
  AUX_SOCKET_FLAGS,
  RECORDING_SESSION_GUIDANCE,
  auxSocketHelp,
} from "./auxSocketHelp";

const usage = auxSocketHelp();
export interface AuxSocketCommand {
  kind: "recording" | "video" | "webrtc";
  request: DeviceGestureRecordingCommand | VideoStreamSocketRequest | WebRtcStreamSocketRequest;
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
export function parseAuxSocketArgs(
  argv: string[],
): AuxSocketCommand | { error: string } | { help: string } {
  if (
    ["--help", "-h", "help"].includes(argv[0]) ||
    (AUX_SOCKET_COMMANDS.includes(argv[0] as AuxSocketCommand["kind"]) &&
      argv.slice(1).some((arg) => arg === "--help" || arg === "-h"))
  ) {
    return { help: usage };
  }
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
      request = { ...value, action: "subscribe" };
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
        (typeof value.whipEndpoint !== "string" || !value.whipEndpoint.trim())
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
  const allowed = Object.keys(AUX_SOCKET_FLAGS).filter((flag) =>
    AUX_SOCKET_FLAGS[flag].kinds.includes(kind),
  );
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
  if (kind === "recording" && (command.observer || !values["--session-uuid"]?.trim())) {
    return { error: RECORDING_SESSION_GUIDANCE };
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
  maxFrameBytes?: number;
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
  request: DeviceGestureRecordingCommand,
  deps: AuxSocketDeps,
  timeoutMs: number,
): Promise<number> {
  return new Promise((done, reject) => {
    // planContent is uncapped generated YAML; allow the shared 8 MiB stream budget.
    const decoder = new LineDecoder(
      deps.maxFrameBytes ?? FAILURES_STREAM_MAX_FRAME_BYTES,
      "Recording response",
    );
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
      if (settled) {
        return;
      }
      const { line, overflow } = decoder.pushFirst(chunk);
      if (line !== undefined) {
        deps.out(line);
        try {
          const response: DeviceGestureRecordingResponse = JSON.parse(line);
          finish(undefined, response.success === true ? 0 : 1);
        } catch (error) {
          finish(new Error(`Invalid recording response: ${errorMessage(error)}`));
        }
      }
      if (overflow) {
        finish(overflow);
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
    // The video acknowledgement is a small JSON object: the auxiliary 1 MiB budget.
    const decoder = new LineDecoder(
      deps.maxFrameBytes ?? AUX_SOCKET_MAX_FRAME_BYTES,
      "Video acknowledgement",
    );
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
      const { line, raw, overflow } = decoder.pushFirst(chunk);
      if (line !== undefined) {
        deps.out(line);
        try {
          ack = JSON.parse(line) as VideoStreamSocketResponse;
          bytesAfterAck += raw.length;
          deps.timer.clearTimeout(timeout);
          if (ack.success !== true) {
            finish("server");
            return;
          }
          hold = deps.timer.setTimeout(() => finish("hold"), command.holdMs);
        } catch (error) {
          finish("server", new Error(`Invalid video ack: ${errorMessage(error)}`));
        }
      }
      if (overflow) {
        finish("server", overflow);
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
  if (command.kind === "recording" && (command.observer || !command.request.sessionUuid?.trim())) {
    deps.err(RECORDING_SESSION_GUIDANCE);
    return 2;
  }
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
            (command.kind === "video"
              ? VIDEO_STREAM_SOCKET_CONFIG
              : DEVICE_GESTURE_RECORDING_SOCKET_CONFIG
            ).defaultPath,
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
          ? await recording(
              connection,
              request as DeviceGestureRecordingCommand,
              deps,
              command.timeoutMs,
            )
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
  const parsed = parseAuxSocketArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`${parsed.error}\nRun aux-socket --help for usage.`);
    return 2;
  }
  if ("help" in parsed) {
    console.log(parsed.help);
    return 0;
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
