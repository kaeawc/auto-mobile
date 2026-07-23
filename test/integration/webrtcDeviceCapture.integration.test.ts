import { afterEach, describe, expect, test } from "bun:test";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { sendWebRtcStreamRequest } from "../../src/daemon/webrtcStreamClient";
import { SIMULATOR_FPS_DEFAULT } from "../../src/features/screen-stream";
import {
  CaptureStageTimeline,
  formatCaptureStageRecord,
  type CaptureDimensions,
} from "../helpers/captureStageTimeline";

const execFileAsync = promisify(execFile);
const runIntegration = process.env.AUTOMOBILE_WEBRTC_DEVICE_INTEGRATION === "1";
const describeIntegration = runIntegration ? describe : describe.skip;
const platform = process.env.AUTOMOBILE_WEBRTC_DEVICE_PLATFORM;
const webRtcPort = 8889;
const streamId = `device-capture-${platform ?? "unknown"}`;
const artifactDir = resolve("scratch/webrtc-device-integration");
// Hosted iOS runners can spend more than three minutes on daemon bootstrap,
// Simulator commands, and Chrome startup before the bounded 30s decode checks.
const deviceIntegrationTimeoutMs = 360_000;
// Mirrors QualityPreset.MEDIUM.fps in android/video-server, which is the quality
// PersistentEncoderH264Source publishes with. Pinned by
// test/integration/webrtcDeviceCaptureLatency.test.ts so the two cannot drift.
const ANDROID_VIDEO_SERVER_MEDIUM_FPS = 60;

interface ChromeTarget { type: string; webSocketDebuggerUrl?: string }
interface CdpResponse { id?: number; result?: { result?: { value?: unknown } }; error?: { message?: string } }
interface ReaderDiagnostics {
  connectionStates: string[];
  inboundVideo: Array<Record<string, unknown>>;
  video: { frames: number; width: number; height: number; readyState: number };
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (response: CdpResponse) => void; reject: (error: Error) => void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", raw => {
      const response = JSON.parse(raw.toString()) as CdpResponse;
      if (response.id === undefined) {return;}
      const pending = this.pending.get(response.id);
      if (!pending) {return;}
      this.pending.delete(response.id);
      response.error ? pending.reject(new Error(response.error.message)) : pending.resolve(response);
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await once(socket, "open");
    return new CdpClient(socket);
  }

  command(method: string, params: Record<string, unknown> = {}): Promise<CdpResponse> {
    const id = this.nextId++;
    const response = new Promise<CdpResponse>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  close(): void { this.socket.close(); }
}

function start(command: string, args: string[], logFile: string): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const log = createWriteStream(logFile, { flags: "a" });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once("close", () => log.end());
  return child;
}

async function waitFor(predicate: () => Promise<boolean>, message: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {return;}
    await Bun.sleep(100);
  }
  throw new Error(message);
}

async function stop(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {return;}
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), Bun.sleep(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}
}

function chromeBinary(): string {
  const candidates = process.env.AUTOMOBILE_CHROME_BINARY
    ? [process.env.AUTOMOBILE_CHROME_BINARY]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const binary = candidates.find(existsSync);
  if (!binary) {throw new Error("Chrome is required for WHEP decoding; set AUTOMOBILE_CHROME_BINARY");}
  return binary;
}

async function openReader(chrome: ChildProcessWithoutNullStreams): Promise<CdpClient> {
  let target: ChromeTarget | undefined;
  await waitFor(async () => {
    try {
      const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json() as ChromeTarget[];
      target = targets.find(candidate => candidate.type === "page" && candidate.webSocketDebuggerUrl);
      return target !== undefined;
    } catch { return false; }
  }, "browser DevTools did not start");
  const cdp = await CdpClient.connect(target!.webSocketDebuggerUrl!);
  await cdp.command("Page.enable");
  await cdp.command("Runtime.enable");
  await cdp.command("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const NativePeerConnection = window.RTCPeerConnection;
      window.__automobilePeerConnections = [];
      window.RTCPeerConnection = class extends NativePeerConnection {
        constructor(...args) {
          super(...args);
          window.__automobilePeerConnections.push(this);
        }
      };
    })();`,
  });
  await cdp.command("Page.navigate", { url: `http://127.0.0.1:${webRtcPort}/${streamId}` });
  await waitFor(async () => {
    try {
      const response = await cdp.command("Runtime.evaluate", {
        expression: `Array.from(window.__automobilePeerConnections ?? [])
          .some(connection => connection.connectionState === "connected")`,
        returnByValue: true,
      });
      return response.result?.result?.value === true;
    } catch {
      return false;
    }
  }, "browser WHEP reader did not connect");
  return cdp;
}

async function videoSample(cdp: CdpClient): Promise<{ frames: number; width: number; height: number; sample: number }> {
  const expression = `(() => { const v = document.querySelector('video'); const q = v?.getVideoPlaybackQuality?.(); if (!v || !v.videoWidth) return {frames: 0, width: 0, height: 0, sample: 0}; const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let sum = 0; for (let i = 0; i < d.length; i += 97) sum = (sum + d[i] + d[i + 1] + d[i + 2]) >>> 0; return {frames: q?.totalVideoFrames ?? 0, width: v.videoWidth, height: v.videoHeight, sample: sum}; })()`;
  const response = await cdp.command("Runtime.evaluate", { expression, returnByValue: true });
  return response.result?.result?.value as { frames: number; width: number; height: number; sample: number };
}

async function readerDiagnostics(cdp: CdpClient): Promise<ReaderDiagnostics> {
  const expression = `(async () => {
    const connections = Array.from(window.__automobilePeerConnections ?? []);
    const reports = (await Promise.all(connections.map(connection => connection.getStats())))
      .flatMap(report => Array.from(report.values()));
    const video = document.querySelector("video");
    return {
      connectionStates: connections.map(connection => connection.connectionState),
      inboundVideo: reports
        .filter(stat => stat.type === "inbound-rtp" && stat.kind === "video")
        .map(stat => ({
          packetsReceived: stat.packetsReceived,
          packetsLost: stat.packetsLost,
          bytesReceived: stat.bytesReceived,
          framesReceived: stat.framesReceived,
          framesDecoded: stat.framesDecoded,
          keyFramesDecoded: stat.keyFramesDecoded,
          pliCount: stat.pliCount,
          nackCount: stat.nackCount,
        })),
      video: {
        frames: video?.getVideoPlaybackQuality?.().totalVideoFrames ?? 0,
        width: video?.videoWidth ?? 0,
        height: video?.videoHeight ?? 0,
        readyState: video?.readyState ?? 0,
      },
    };
  })()`;
  const response = await cdp.command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return response.result?.result?.value as ReaderDiagnostics;
}

async function waitForDecodedFrames(cdp: CdpClient, minimum: number, message: string): Promise<void> {
  try {
    await waitFor(async () => (await videoSample(cdp)).frames > minimum, message);
  } catch {
    const diagnostics = await readerDiagnostics(cdp).catch(() => undefined);
    throw new Error(`${message}; reader diagnostics=${JSON.stringify(diagnostics ?? "unavailable")}`);
  }
}

function androidDeviceId(): string {
  return process.env.AUTOMOBILE_ANDROID_H264_DEVICE_ID ?? "emulator-5554";
}

interface CaptureProfile {
  sourceSize: CaptureDimensions | null;
  configuredFps: number | null;
}

/**
 * Capture profile recorded with the stage timings (#4343) so latency samples
 * from different runners can be compared like for like.
 */
async function captureProfile(): Promise<CaptureProfile> {
  // Android screenrecord follows the display refresh rate, which the pipeline
  // never configures; only the persistent encoder publishes a chosen fps.
  const usesVideoServer =
    Boolean(process.env.AUTOMOBILE_VIDEO_SERVER_JAR) || process.env.AUTOMOBILE_REQUIRE_VIDEO_SERVER === "1";
  const configuredFps = platform === "android"
    ? (usesVideoServer ? ANDROID_VIDEO_SERVER_MEDIUM_FPS : null)
    : SIMULATOR_FPS_DEFAULT;
  try {
    if (platform === "android") {
      const { stdout } = await execFileAsync("adb", ["-s", androidDeviceId(), "shell", "wm", "size"]);
      const match = /Physical size:\s*(\d+)x(\d+)/.exec(stdout);
      return { sourceSize: match ? { width: Number(match[1]), height: Number(match[2]) } : null, configuredFps };
    }
    const { stdout } = await execFileAsync("xcrun", ["simctl", "io", "booted", "enumerate"]);
    const match = /Pixel Size:\s*\{(\d+),\s*(\d+)\}/.exec(stdout);
    return { sourceSize: match ? { width: Number(match[1]), height: Number(match[2]) } : null, configuredFps };
  } catch (error) {
    // Diagnostic metadata only — a failed size query must not fail the lane.
    console.warn(`[#4343] could not query capture source resolution: ${error}`);
    return { sourceSize: null, configuredFps };
  }
}

async function launchFixture(): Promise<void> {
  if (platform === "android") {
    const id = androidDeviceId();
    await execFileAsync("adb", ["-s", id, "shell", "am", "start", "-a", "android.settings.SETTINGS"]);
    await execFileAsync("adb", ["-s", id, "shell", "cmd", "uimode", "night", "no"]);
    return;
  }
  if (platform === "ios") {
    await execFileAsync("xcrun", ["simctl", "launch", "booted", "com.apple.Preferences"]);
    await execFileAsync("xcrun", ["simctl", "ui", "booted", "appearance", "light"]);
    return;
  }
  throw new Error("AUTOMOBILE_WEBRTC_DEVICE_PLATFORM must be android or ios");
}

async function changeFixture(): Promise<void> {
  if (platform === "android") {
    const id = androidDeviceId();
    // A Home transition guarantees a visible surface change. The emulator may
    // accept a ui-mode setting without repainting the Settings window, which
    // made the old theme-only fixture indistinguishable from a frozen stream.
    await execFileAsync("adb", ["-s", id, "shell", "input", "keyevent", "HOME"]);
    return;
  }
  if (platform === "ios") {
    await execFileAsync("xcrun", ["simctl", "ui", "booted", "appearance", "dark"]);
    return;
  }
  throw new Error("AUTOMOBILE_WEBRTC_DEVICE_PLATFORM must be android or ios");
}

afterEach(async () => {
  if (platform === "android") {
    const id = androidDeviceId();
    await execFileAsync("adb", ["-s", id, "shell", "cmd", "uimode", "night", "no"]).catch(() => undefined);
  }
  if (platform === "ios") {await execFileAsync("xcrun", ["simctl", "ui", "booted", "appearance", "light"]).catch(() => undefined);}
});

describeIntegration("device capture -> WHIP -> MediaMTX -> WHEP (#4308)", () => {
  test("the real device capture path renders changing video and stops cleanly", async () => {
    if (!process.env.AUTOMOBILE_MEDIAMTX_BINARY) {throw new Error("MediaMTX runner did not provide AUTOMOBILE_MEDIAMTX_BINARY");}
    await mkdir(artifactDir, { recursive: true });
    const daemonDir = await mkdtemp(join(artifactDir, "daemon-"));
    const daemonDbDir = join(daemonDir, "db");
    // macOS limits Unix-domain socket paths to 104 bytes. The artifact directory
    // is deliberately descriptive and can exceed that limit on hosted runners,
    // so keep only this control socket in a short, isolated temp directory.
    const webRtcSocketDir = await mkdtemp(join(tmpdir(), "am-ws-"));
    const webRtcSocketPath = join(webRtcSocketDir, "stream.sock");
    await mkdir(daemonDbDir);
    const daemonEnvironment = {
      ...process.env,
      AUTOMOBILE_DATA_DIR: daemonDir,
      AUTOMOBILE_DB_DIR: daemonDbDir,
      AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS: "60000",
      AUTOMOBILE_DAEMON_SOCKET_PATH: join(daemonDir, "daemon.sock"),
      AUTOMOBILE_DAEMON_PID_FILE_PATH: join(daemonDir, "daemon.pid"),
      AUTOMOBILE_DAEMON_LOCK_FILE_PATH: join(daemonDir, "daemon.lock"),
      AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH: webRtcSocketPath,
    };
    delete daemonEnvironment.AUTOMOBILE_DB_PATH;
    delete daemonEnvironment.AUTO_MOBILE_DB_PATH;
    const mediamtx = start(process.env.AUTOMOBILE_MEDIAMTX_BINARY, ["examples/mediamtx/mediamtx.yml"], join(artifactDir, "mediamtx.log"));
    let chrome: ChildProcessWithoutNullStreams | undefined;
    let cdp: CdpClient | undefined;
    let started = false;
    const timeline = new CaptureStageTimeline();
    let profile: CaptureProfile = { sourceSize: null, configuredFps: null };
    let decodedSize: CaptureDimensions | null = null;
    let outcome: "passed" | "failed" = "failed";
    let observingWhip = true;
    let whipObserver: Promise<void> = Promise.resolve();
    try {
      await waitFor(async () => {
        if (mediamtx.exitCode !== null || mediamtx.signalCode !== null) {
          throw new Error("MediaMTX exited before it became ready; inspect scratch/webrtc-device-integration/mediamtx.log");
        }
        const response = await fetch(`http://127.0.0.1:${webRtcPort}/`).catch(() => undefined);
        if (!response) {return false;}
        await Bun.sleep(100);
        return mediamtx.exitCode === null && mediamtx.signalCode === null;
      }, "MediaMTX did not become ready");
      started = true;
      await execFileAsync("bun", ["dist/src/index.js", "--daemon", "start"], { env: daemonEnvironment }).catch(() => undefined);
      await waitFor(async () => {
        try {
          const response = await sendWebRtcStreamRequest(
            { action: "list", id: `${streamId}-daemon-ready` },
            { socketPath: webRtcSocketPath, timeoutMs: 1_000 }
          );
          return response.success;
        } catch { return false; }
      }, "AutoMobile daemon did not become ready");
      await launchFixture();
      profile = await captureProfile();
      timeline.mark("startRequest");
      // The start request only returns once the publisher has connected AND the
      // capture source has started, so the WHIP connect has to be observed from
      // a concurrent poller. It never throws — a lost sample must not fail the
      // lane, and every wait below keeps its own timeout.
      whipObserver = (async () => {
        while (observingWhip && !timeline.has("whipConnected")) {
          const status = await sendWebRtcStreamRequest(
            { action: "status", id: `${streamId}-whip-status`, streamId },
            { socketPath: webRtcSocketPath, timeoutMs: 1_000 }
          ).catch(() => undefined);
          if (status?.stream?.state === "connected") {
            timeline.mark("whipConnected");
            return;
          }
          await Bun.sleep(50);
        }
      })();
      const response = await sendWebRtcStreamRequest(
        { action: "start", id: streamId, streamId, platform, whipEndpoint: `http://127.0.0.1:${webRtcPort}/${streamId}/whip` },
        { socketPath: webRtcSocketPath }
      );
      if (!response.success) {
        throw new Error(`failed to start device WebRTC stream: ${response.error ?? "no error detail returned"}`);
      }
      timeline.mark("sourceStarted");
      await waitFor(async () => {
        const status = await sendWebRtcStreamRequest(
          { action: "status", id: `${streamId}-capture-status`, streamId },
          { socketPath: webRtcSocketPath, timeoutMs: 1_000 }
        ).catch(() => undefined);
        if ((status?.stream?.framesSent ?? 0) === 0) {
          return false;
        }
        timeline.mark("firstEncodedFrame");
        return true;
      }, "capture source did not deliver H.264 frames to the WHIP publisher");
      chrome = start(chromeBinary(), ["--headless=new", "--autoplay-policy=no-user-gesture-required", "--remote-debugging-port=9222", "--no-first-run", "about:blank"], join(artifactDir, "chrome.log"));
      cdp = await openReader(chrome);
      timeline.mark("whepConnected");
      // The device can be idle by the time the WHEP reader connects. Trigger a
      // visible transition after subscription so the reader receives a fresh
      // encoded access unit rather than waiting on an earlier keyframe.
      await changeFixture();
      await waitForDecodedFrames(cdp, 0, "browser did not decode device video");
      timeline.mark("firstDecodedFrame");
      const first = await videoSample(cdp);
      decodedSize = { width: first.width, height: first.height };
      await launchFixture();
      await waitForDecodedFrames(cdp, first.frames, "browser did not receive video after returning to the fixture");
      const second = await videoSample(cdp);
      expect(first.width).toBeGreaterThan(0);
      expect(first.height).toBeGreaterThan(0);
      expect(second.frames).toBeGreaterThan(first.frames);
      expect(second.sample).not.toBe(first.sample);
      const stopped = await sendWebRtcStreamRequest(
        { action: "stop", id: `${streamId}-stop`, streamId },
        { socketPath: webRtcSocketPath }
      );
      expect(stopped.success).toBe(true);
      const listed = await sendWebRtcStreamRequest(
        { action: "list", id: `${streamId}-list` },
        { socketPath: webRtcSocketPath }
      );
      expect(listed.streams?.some(stream => stream.streamId === streamId)).toBe(false);
      outcome = "passed";
    } finally {
      observingWhip = false;
      await whipObserver;
      cdp?.close();
      await stop(chrome);
      if (started) {await execFileAsync("bun", ["dist/src/index.js", "--daemon", "stop"], { env: daemonEnvironment }).catch(() => undefined);}
      await stop(mediamtx);
      await rm(webRtcSocketDir, { recursive: true, force: true });
      // Written for passing runs too: the p50/p95 baselines this feeds (#4343)
      // need the successful samples, and a failure keeps whatever it reached.
      const record = timeline.toRecord({
        platform: platform ?? "unknown",
        streamId,
        outcome,
        sourceSize: profile.sourceSize,
        configuredFps: profile.configuredFps,
        decodedSize,
      });
      const summary = formatCaptureStageRecord(record);
      await writeFile(join(artifactDir, "stage-latency.json"), `${JSON.stringify(record, null, 2)}\n`);
      await writeFile(join(artifactDir, "result.txt"), `${summary}\n`);
      console.log(`[#4343] device capture stage latency\n${summary}`);
    }
  }, deviceIntegrationTimeoutMs);
});
