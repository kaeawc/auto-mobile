import { afterEach, beforeEach, expect, test } from "bun:test";
import { basename, join, resolve } from "node:path";
import {
  parseAuxSocketArgs,
  runAuxSocket,
  type AuxSocketCommand,
  type AuxSocketDeps,
} from "../../scripts/manual-test/aux-socket";
import { derivePrivateDaemonBatch } from "../../scripts/manual-test/privateDaemonEnv";
import type { FrameConnection } from "../../scripts/manual-test/frameWire";
import {
  DEVICE_GESTURE_RECORDING_SOCKET_CONFIG,
  VIDEO_STREAM_SOCKET_CONFIG,
  resolveWebRtcStreamSocketPath,
} from "../../src/daemon/daemonFiles";
import type { WebRtcStreamSocketRequest } from "../../src/daemon/webrtcStreamSocketTypes";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

import { testOverrides } from "../../src/utils/testOverrides";
const previousAux = testOverrides.auxSocketDir;
beforeEach(() => {
  testOverrides.auxSocketDir = undefined;
});
afterEach(() => {
  testOverrides.auxSocketDir = previousAux;
});

const posixTest = process.platform === "win32" ? test.skip : test;

class FakeConnection implements FrameConnection {
  writes: Array<Record<string, unknown>> = [];
  ended = false;
  data: (chunk: Buffer) => void = () => {};
  close: (error?: Error) => void = () => {};
  respond: (frame: Record<string, unknown>) => void = () => {};
  write(line: string): void {
    const frame: Record<string, unknown> = JSON.parse(line);
    this.writes.push(frame);
    this.respond(frame);
  }
  push(value: unknown): void {
    this.data(Buffer.from(JSON.stringify(value) + "\n"));
  }
  onData(listener: (chunk: Buffer) => void): void {
    this.data = listener;
  }
  onClose(listener: (error?: Error) => void): void {
    this.close = listener;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.close();
  }
}
function parsed(args: string[]): AuxSocketCommand {
  const command = parseAuxSocketArgs(args);
  if ("error" in command) {
    throw new Error(command.error);
  }
  return command;
}
function fixture() {
  const control = new FakeConnection(),
    aux = new FakeConnection(),
    timer = new FakeTimer();
  const paths: string[] = [],
    out: string[] = [],
    err: string[] = [];
  const webCalls: Array<{ request: WebRtcStreamSocketRequest; socketPath?: string }> = [];
  control.respond = (frame) =>
    control.push({
      id: frame.id,
      type: "mcp_response",
      success: true,
      result:
        frame.method === "daemon/registerSession"
          ? { accepted: true, heartbeatTimeoutMs: 8000 }
          : {},
    });
  aux.respond = () => aux.push({ success: true });
  const deps: AuxSocketDeps = {
    env: {
      ...derivePrivateDaemonBatch({
        batchDir: resolve("/fake/batch"),
        count: 1,
        basePort: 3160,
        auxRoot: resolve("/fake/aux"),
        serverPath: resolve("/fake/server"),
      })[0].env,
      AUTOMOBILE_AUX_SOCKET_DIR: resolve("/fake/aux"),
      AUTOMOBILE_DAEMON_SOCKET_PATH: resolve("/fake/aux/d.sock"),
      MT_SERVER: resolve("/fake/server"),
    },
    host: { homeDirs: [resolve("/fake/home")], uid: 424242, canonicalize: resolve },
    timer,
    ids: new FakeIdGenerator(),
    connect: async (path) => {
      paths.push(path);
      return path === deps.env.AUTOMOBILE_DAEMON_SOCKET_PATH ? control : aux;
    },
    sendWebRtc: async (request, options) => {
      webCalls.push({ request, socketPath: options?.socketPath });
      return { type: "webrtc_stream_response", success: true };
    },
    out: (line) => {
      out.push(line);
    },
    err: (line) => {
      err.push(line);
    },
  };
  return { control, aux, timer, paths, out, err, webCalls, deps };
}
test("parses recording fields, common flags, video and each WebRTC action", () => {
  const c = parsed([
    "recording",
    "start",
    "--device-id",
    "dev",
    "--platform",
    "ios",
    "--recording-id",
    "rec",
    "--plan-name",
    "plan",
    "--session-uuid",
    "uuid",
    "--heartbeat-ms",
    "1000",
    "--observer-name",
    "named",
  ]);
  expect(c.request).toEqual({
    command: "start",
    deviceId: "dev",
    platform: "ios",
    recordingId: "rec",
    planName: "plan",
    sessionUuid: "uuid",
  });
  expect(c.heartbeatMs).toBe(1000);
  expect(c.observerName).toBe("named");
  expect(
    parsed(["video", '{"action":"subscribe","quality":"low"}', "--observer", "--hold-ms", "10"])
      .holdMs,
  ).toBe(10);
  for (const action of ["stop", "status", "list", "await"]) {
    expect(parsed(["webrtc", action, "{}", "--timeout-ms", "10"]).request).toEqual({ action });
  }
  expect(
    parsed(["webrtc", "start", '{"whipEndpoint":"https://example.invalid/whip"}']).request,
  ).toHaveProperty("whipEndpoint");
});
test("rejects usage, JSON, duplicates, missing values, invalid options and observer conflicts", () => {
  for (const args of [
    [],
    ["other", "status"],
    ["recording", "wrong"],
    ["recording", "status", "--platform", "wrong"],
    ["recording", "status", "--observer", "--session-uuid", "uuid"],
    ["recording", "status", "--heartbeat-ms", "0"],
    ["recording", "status", "--wat"],
    ["recording", "status", "--device-id"],
    ["recording", "status", "--device-id", "x", "--device-id", "y"],
    ["video", "not-json"],
    ["video", "[]"],
    ["video", '{"action":"unsubscribe"}'],
    ["video", '{"action":"subscribe","sessionUuid":"uuid"}', "--observer"],
    ["video", '{"action":"subscribe"}', "--hold-ms", "-1"],
    ["webrtc", "start"],
    ["webrtc", "start", '{"whipEndpoint":""}'],
    ["webrtc", "status", "--timeout-ms", "2147483648"],
    ["webrtc", "wat"],
  ]) {
    expect(parseAuxSocketArgs(args)).toHaveProperty("error");
  }
});
posixTest("private environment refusal never connects or sends WebRTC", async () => {
  const f = fixture();
  f.deps.env = {};
  expect(await runAuxSocket(parsed(["recording", "status"]), f.deps)).toBe(2);
  expect(await runAuxSocket(parsed(["webrtc", "list"]), f.deps)).toBe(2);
  expect(f.paths).toEqual([]);
  expect(f.webCalls).toEqual([]);
});
posixTest(
  "recording status round trip derives path from explicit auxiliary directory",
  async () => {
    const f = fixture();
    expect(
      await runAuxSocket(parsed(["recording", "status", "--session-uuid", "uuid"]), f.deps),
    ).toBe(0);
    expect(f.paths).toEqual([
      join(
        f.deps.env.AUTOMOBILE_AUX_SOCKET_DIR!,
        basename(DEVICE_GESTURE_RECORDING_SOCKET_CONFIG.defaultPath),
      ),
    ]);
    expect(f.aux.writes).toEqual([{ command: "status", sessionUuid: "uuid" }]);
    expect(f.out).toEqual(['{"success":true}']);
    expect(f.aux.ended).toBe(true);
  },
);
posixTest(
  "observer registers, injects UUID, heartbeats during video hold and releases on exit",
  async () => {
    const f = fixture();
    f.aux.respond = () =>
      f.aux.data(
        Buffer.concat([
          Buffer.from('{"type":"video_stream_response","success":true}\n'),
          Buffer.from([255, 10, 0]),
        ]),
      );
    const task = runAuxSocket(
      parsed([
        "video",
        '{"action":"subscribe"}',
        "--observer",
        "--observer-name",
        "viewer",
        "--hold-ms",
        "4500",
      ]),
      f.deps,
    );
    await drainUntilQuiescent(f.timer);
    expect(f.control.writes[0]).toMatchObject({
      method: "daemon/registerSession",
      params: { sessionId: "fake-1", clientName: "viewer" },
    });
    expect(f.aux.writes[0]).toEqual({ action: "subscribe", sessionUuid: "fake-1" });
    f.timer.advanceTime(2000);
    await drainUntilQuiescent(f.timer);
    expect(f.control.writes[1]).toMatchObject({
      method: "daemon/heartbeat",
      params: { sessionId: "fake-1" },
    });
    f.aux.data(Buffer.from([3, 4]));
    f.timer.advanceTime(2000);
    await drainUntilQuiescent(f.timer);
    f.timer.advanceTime(500);
    expect(await task).toBe(0);
    expect(f.control.writes.at(-1)).toMatchObject({
      method: "daemon/releaseSession",
      params: { sessionId: "fake-1" },
    });
    expect(JSON.parse(f.out.at(-2)!)).toMatchObject({ bytesAfterAck: 5, closedBy: "hold" });
    expect(f.paths[1]).toBe(
      join(f.deps.env.AUTOMOBILE_AUX_SOCKET_DIR!, basename(VIDEO_STREAM_SOCKET_CONFIG.defaultPath)),
    );
    const n = f.control.writes.length;
    f.timer.advanceTime(10000);
    expect(f.control.writes).toHaveLength(n);
    expect(f.control.ended).toBe(true);
  },
);
posixTest(
  "refused observer registration prints full refusal and sends no auxiliary request",
  async () => {
    const f = fixture();
    f.control.respond = (frame) =>
      f.control.push({
        id: frame.id,
        type: "mcp_response",
        success: false,
        code: "observer_refused",
        error: "full refusal",
      });
    expect(await runAuxSocket(parsed(["recording", "status", "--observer"]), f.deps)).toBe(1);
    expect(f.paths).toHaveLength(1);
    expect(f.aux.writes).toEqual([]);
    expect(f.out[0]).toContain("observer_refused");
  },
);
posixTest(
  "observer cadence at or above lease refuses, releases registration, never sends aux",
  async () => {
    const f = fixture();
    expect(
      await runAuxSocket(
        parsed(["recording", "status", "--observer", "--heartbeat-ms", "8000"]),
        f.deps,
      ),
    ).toBe(2);
    expect(f.control.writes.at(-1)?.method).toBe("daemon/releaseSession");
    expect(f.aux.writes).toEqual([]);
  },
);
posixTest("video failed acknowledgement exits 1, server close reports all bytes", async () => {
  const f = fixture();
  f.aux.respond = () =>
    f.aux.push({ type: "video_stream_response", success: false, error: "typed refusal" });
  expect(await runAuxSocket(parsed(["video", '{"action":"subscribe"}']), f.deps)).toBe(1);
  expect(JSON.parse(f.out[1])).toMatchObject({ ack: { success: false }, bytesAfterAck: 0 });
  f.aux.respond = () => {
    f.aux.push({ type: "video_stream_response", success: true });
    f.aux.data(Buffer.from([1, 2]));
    f.aux.close();
  };
  expect(await runAuxSocket(parsed(["video", '{"action":"subscribe"}']), f.deps)).toBe(0);
  expect(JSON.parse(f.out.at(-1)!)).toMatchObject({ bytesAfterAck: 2, closedBy: "server" });
});
posixTest(
  "WebRTC uses the repo sender seam with explicit private socket and parsed success",
  async () => {
    const f = fixture();
    f.deps.env.AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH = resolve("/fake/inherited-other.sock");
    expect(await runAuxSocket(parsed(["webrtc", "list", "--observer"]), f.deps)).toBe(0);
    expect(f.webCalls[0]).toEqual({
      request: { action: "list", sessionUuid: "fake-1" },
      socketPath: resolveWebRtcStreamSocketPath({
        AUTOMOBILE_AUX_SOCKET_DIR: f.deps.env.AUTOMOBILE_AUX_SOCKET_DIR,
      }),
    });
    f.deps.sendWebRtc = async () => ({
      type: "webrtc_stream_response",
      success: false,
      error: "full refusal",
    });
    expect(await runAuxSocket(parsed(["webrtc", "status", "--session-uuid", "uuid"]), f.deps)).toBe(
      1,
    );
    expect(f.out.at(-1)).toContain("full refusal");
  },
);
posixTest("recording timeout cleans observer heartbeat and releases on exit", async () => {
  const f = fixture();
  f.aux.respond = () => {};
  const task = runAuxSocket(
    { ...parsed(["recording", "status", "--observer"]), timeoutMs: 10 },
    f.deps,
  );
  await drainUntilQuiescent(f.timer);
  f.timer.advanceTime(10);
  expect(await task).toBe(3);
  expect(f.control.writes.at(-1)?.method).toBe("daemon/releaseSession");
  expect(f.timer.getPendingIntervalCount()).toBe(0);
});

posixTest("canonical auxiliary socket pointing into default state refuses before I/O", async () => {
  const f = fixture();
  const socket = join(
    f.deps.env.AUTOMOBILE_AUX_SOCKET_DIR!,
    basename(DEVICE_GESTURE_RECORDING_SOCKET_CONFIG.defaultPath),
  );
  f.deps.host.canonicalize = (path) =>
    path === socket ? resolve("/fake/home/.auto-mobile/recording.sock") : resolve(path);
  expect(await runAuxSocket(parsed(["recording", "status"]), f.deps)).toBe(2);
  expect(f.paths).toEqual([]);
  expect(f.webCalls).toEqual([]);
  expect(f.err.join(" ")).toContain("default product");
});
