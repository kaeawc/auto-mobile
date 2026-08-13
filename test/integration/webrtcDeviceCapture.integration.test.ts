import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { sendWebRtcStreamRequest } from "../../src/daemon/webrtcStreamClient";
import { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { WEBRTC_IOS_SIMULATOR_FPS_DEFAULT } from "../../src/features/webrtc/webrtcStreamingConfig";
import { IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS } from "../../src/features/webrtc/IosH264Source";
import { WEBRTC_STREAM_LEASE_TTL_MS } from "../../src/server/webrtcStreamManager";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";
import {
  CaptureStageTimeline,
  captureRunIdentity,
  decodedFpsBetween,
  egressKbpsBetween,
  formatCaptureStageRecord,
  keyframeRecovered,
  type CaptureDimensions,
  type CaptureStage,
  type CaptureStageContext,
  type EgressSample,
  type KeyframeRecoverySample,
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
// PersistentEncoderH264Source publishes with. The host now also defaults the
// `--fps` override to WEBRTC_ANDROID_FPS_DEFAULT (30), which matches this preset
// default. Pinned by test/integration/webrtcDeviceCaptureLatency.test.ts so the
// two cannot drift.
const ANDROID_VIDEO_SERVER_MEDIUM_FPS = 30;

// The cosmetic fixture-restore hook contends with a just-stopped capture; a
// simctl/adb call that wedges must be killed rather than block the hook. Bounds
// the restore subprocess itself, so the hook deadline below is never reached by
// a hung child (#4354).
const FIXTURE_RESTORE_TIMEOUT_MS = 15_000;
// bun caps a hook with no explicit deadline at 5000ms, which is what turned a
// slow appearance restore into a failed run whose pipeline recorded `passed`.
// Give the hook its own generous timeout, comfortably past the restore budget.
const TEARDOWN_HOOK_TIMEOUT_MS = 30_000;

interface ChromeTarget { type: string; webSocketDebuggerUrl?: string }
interface CdpResponse { id?: number; result?: { result?: { value?: unknown } }; error?: { message?: string } }
interface ReaderDiagnostics {
  connectionStates: string[];
  inboundVideo: Array<Record<string, unknown>>;
  video: { frames: number; width: number; height: number; readyState: number };
}

interface ChromeReader {
  chrome: ChildProcessWithoutNullStreams;
  cdp: CdpClient;
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

async function waitForWebRtcStreamSocket(
  socketPath: string,
  // Match AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS (60s) so a merely-slow daemon is
  // not abandoned inside its own startup budget.
  timeoutMs = 60_000
): Promise<void> {
  // Retain WHY the last probe failed. A rejected request returns success=false
  // with an error (e.g. the stream-socket auth guard), and a dropped socket
  // throws; surface either in the timeout so a regression is diagnosable from the
  // job console instead of only the uploaded daemon log.
  let lastDetail = "no response from the daemon stream socket yet";
  try {
    await waitFor(
      async () => {
        try {
          const response = await sendWebRtcStreamRequest(
            { action: "list", id: `${streamId}-daemon-ready` },
            { socketPath, timeoutMs: 1_000 }
          );
          if (response.success) {
            return true;
          }
          lastDetail = response.error ?? "request rejected without an error detail";
          return false;
        } catch (error) {
          lastDetail = error instanceof Error ? error.message : String(error);
          return false;
        }
      },
      "unused",
      timeoutMs
    );
  } catch {
    throw new Error(`AutoMobile daemon stream socket did not become ready: ${lastDetail}`);
  }
}

async function startWebRtcDaemon(daemonEnvironment: NodeJS.ProcessEnv, socketPath: string): Promise<void> {
  // Keep the start command's own failure instead of fully swallowing it, so a
  // daemon that never spawns is reported alongside the readiness timeout rather
  // than surfacing only as a generic "socket did not become ready".
  const startError = await execFileAsync("bun", ["dist/src/index.js", "--daemon", "start"], {
    env: daemonEnvironment,
  })
    .then(() => null)
    .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  try {
    await waitForWebRtcStreamSocket(socketPath);
  } catch (readyError) {
    if (startError) {
      throw new Error(
        `${readyError instanceof Error ? readyError.message : String(readyError)}; ` +
          `daemon start command failed: ${startError.message}`
      );
    }
    throw readyError;
  }
}

/**
 * Chrome startup can contend with the hosted runner enough for the daemon's
 * short database-health probe to exit the isolated process. The integration
 * assertion concerns device capture, so recover that process once before the
 * measured stream request rather than reporting a raw ENOENT from the socket.
 */
async function ensureWebRtcDaemon(socketPath: string, daemonEnvironment: NodeJS.ProcessEnv): Promise<void> {
  try {
    const response = await sendWebRtcStreamRequest(
      { action: "list", id: `${streamId}-daemon-health` },
      { socketPath, timeoutMs: 1_000 }
    );
    if (response.success) {
      return;
    }
  } catch {
    // Restart below. The bounded readiness wait retains the underlying failure.
  }
  await startWebRtcDaemon(daemonEnvironment, socketPath);
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

const CHROME_DEBUG_PORT = 9222;
const CHROME_LAUNCH_ARGS = [
  "--headless=new",
  "--autoplay-policy=no-user-gesture-required",
  `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
  "--no-first-run",
  "about:blank",
];

/** The Chrome process exit status + a tail of its log, for diagnosing a
 * headless-startup flake (the log was empty and unsurfaced before #4409). */
function chromeDiagnostics(chrome: ChildProcessWithoutNullStreams, logFile: string): string {
  let tail = "(empty)";
  try {
    const contents = readFileSync(logFile, "utf8").trim();
    if (contents) { tail = contents.slice(-1500); }
  } catch { /* the log may not exist if the spawn itself failed */ }
  return `chrome exitCode=${chrome.exitCode} signal=${chrome.signalCode} log=${tail}`;
}

/**
 * Launch headless Chrome and connect the CDP reader, relaunching once if Chrome
 * fails to expose DevTools — headless Chrome startup is a known flake on the
 * hosted macOS runner image (#4409). Each attempt uses a fresh profile so a
 * stale user-data lock cannot wedge the relaunch. Returns the live process so
 * the caller can tear it down.
 */
async function launchChromeReader(logFile: string): Promise<ChromeReader> {
  const maxAttempts = 2;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const userDataDir = await mkdtemp(join(tmpdir(), "automobile-chrome-"));
    const chrome = start(chromeBinary(), [...CHROME_LAUNCH_ARGS, `--user-data-dir=${userDataDir}`], logFile);
    try {
      const cdp = await connectReader(chrome, logFile);
      return { chrome, cdp };
    } catch (error) {
      lastError = error as Error;
      await stop(chrome);
      // Free the debugging port before relaunching on the same port.
      if (attempt < maxAttempts) { await Bun.sleep(1_000); }
    }
  }
  throw lastError ?? new Error("browser DevTools did not start");
}

/**
 * Wait for Chrome's DevTools endpoint and install the peer-connection hook,
 * without subscribing yet. Kept separate from {@link subscribeReader} so
 * Chrome's cold start — seconds on a hosted runner — stays outside the measured
 * window and does not land in the WHEP-connect stage (#4343). Fails fast if the
 * Chrome process exits during startup, and attaches the process exit status +
 * log tail to the error so a headless flake is diagnosable (#4409).
 */
async function connectReader(chrome: ChildProcessWithoutNullStreams, logFile: string): Promise<CdpClient> {
  let target: ChromeTarget | undefined;
  try {
    await waitFor(async () => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) {
        throw new Error("chrome exited before exposing DevTools");
      }
      try {
        const targets = await (await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/list`)).json() as ChromeTarget[];
        target = targets.find(candidate => candidate.type === "page" && candidate.webSocketDebuggerUrl);
        return target !== undefined;
      } catch { return false; }
    }, "browser DevTools did not start");
  } catch (error) {
    throw new Error(`${(error as Error).message}; ${chromeDiagnostics(chrome, logFile)}`);
  }
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
  return cdp;
}

/** Subscribe the already-running browser to the WHEP stream. On a connect
 * timeout, attach the RTCPeerConnection diagnostics (ICE state, candidates) so
 * a WHEP-connect flake is diagnosable rather than a bare message (#4409). */
async function subscribeReader(cdp: CdpClient): Promise<void> {
  await cdp.command("Page.navigate", { url: `http://127.0.0.1:${webRtcPort}/${streamId}` });
  try {
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
  } catch (error) {
    const diagnostics = await readerDiagnostics(cdp).catch(() => undefined);
    throw new Error(`${(error as Error).message}; reader diagnostics=${JSON.stringify(diagnostics ?? "unavailable")}`);
  }
}

/**
 * The macOS hosted image can leave a previously healthy Chrome renderer unable
 * to create its next WHEP peer connection. A new browser/profile turns that
 * browser-only flake into one bounded retry while preserving the actual
 * keyframe-recovery assertion below.
 */
async function subscribeRecoveryReader(reader: ChromeReader, logFile: string): Promise<ChromeReader> {
  try {
    await subscribeReader(reader.cdp);
    return reader;
  } catch (firstError) {
    reader.cdp.close();
    await stop(reader.chrome);
    await Bun.sleep(1_000);
    const replacement = await launchChromeReader(logFile);
    try {
      await subscribeReader(replacement.cdp);
      return replacement;
    } catch (retryError) {
      replacement.cdp.close();
      await stop(replacement.chrome);
      throw new Error(
        `WHEP recovery reader failed after a fresh-browser retry: ` +
        `first=${firstError instanceof Error ? firstError.message : String(firstError)}; ` +
        `retry=${retryError instanceof Error ? retryError.message : String(retryError)}`
      );
    }
  }
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

/**
 * One cumulative inbound-RTP reading for the egress-bitrate / decoded-fps
 * measurement (#4349). Uses the WebRTC stat's own `timestamp` for the window so
 * the rate does not depend on the test host's wall clock. Returns null when no
 * inbound-video stat is available yet — a missing sample must never fail the
 * lane, so the caller treats null as "not measured".
 */
async function egressSample(cdp: CdpClient): Promise<EgressSample | null> {
  const expression = `(async () => {
    const connections = Array.from(window.__automobilePeerConnections ?? []);
    const reports = (await Promise.all(connections.map(connection => connection.getStats())))
      .flatMap(report => Array.from(report.values()));
    const inbound = reports.find(stat => stat.type === "inbound-rtp" && stat.kind === "video");
    if (!inbound) { return null; }
    return {
      bytesReceived: inbound.bytesReceived ?? 0,
      framesDecoded: inbound.framesDecoded ?? 0,
      timestampMs: inbound.timestamp ?? 0,
    };
  })()`;
  const response = await cdp.command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return (response.result?.result?.value as EgressSample | null) ?? null;
}

async function waitForDecodedFrames(cdp: CdpClient, minimum: number, message: string): Promise<void> {
  try {
    await waitFor(async () => (await videoSample(cdp)).frames > minimum, message);
  } catch {
    const diagnostics = await readerDiagnostics(cdp).catch(() => undefined);
    throw new Error(`${message}; reader diagnostics=${JSON.stringify(diagnostics ?? "unavailable")}`);
  }
}

/**
 * Wait until the decoded frame's content actually differs from `previousSample`, returning that
 * frame. Frame *count* is no longer a proxy for a visible change: the encoder's idle-frame backstop
 * (#4383) advances the counter with forced repeats of an unchanged screen, so a count-based wait can
 * return on a still frame. Content-difference is what proves a visible transition rendered.
 */
/**
 * Wait until the decoded video shows different content than `previous` AND the
 * decode counter has advanced past `previous.frames`. Frame progress is part of
 * the bounded wait rather than a one-shot assertion afterwards: Chromium's
 * `getVideoPlaybackQuality().totalVideoFrames` is not updated in lockstep with
 * the compositor frame the canvas samples, so a single snapshot taken the
 * moment the pixels change can still carry the previous counter value (#4409).
 */
async function waitForChangedSample(
  cdp: CdpClient,
  previous: { sample: number; frames: number },
  message: string
): Promise<{ frames: number; width: number; height: number; sample: number }> {
  let latest = await videoSample(cdp);
  try {
    await waitFor(async () => {
      latest = await videoSample(cdp);
      return latest.frames > previous.frames && latest.sample !== previous.sample;
    }, message);
  } catch {
    const diagnostics = await readerDiagnostics(cdp).catch(() => undefined);
    throw new Error(`${message}; reader diagnostics=${JSON.stringify(diagnostics ?? "unavailable")}`);
  }
  return latest;
}

/**
 * Cumulative keyframe/frame decode counters for the recovery viewer — the most
 * recent WHEP subscription, so the last peer connection the hook recorded
 * (#4376). Returns null when no inbound-video stat is available yet (the fresh
 * subscription has not decoded anything), which the caller treats as "not yet
 * recovered" rather than a failure.
 */
async function recoverySample(cdp: CdpClient): Promise<KeyframeRecoverySample | null> {
  const expression = `(async () => {
    const connections = Array.from(window.__automobilePeerConnections ?? []);
    const latest = connections[connections.length - 1];
    if (!latest) { return null; }
    const reports = Array.from((await latest.getStats()).values());
    const inbound = reports.find(stat => stat.type === "inbound-rtp" && stat.kind === "video");
    if (!inbound) { return null; }
    return {
      keyFramesDecoded: inbound.keyFramesDecoded ?? 0,
      framesDecoded: inbound.framesDecoded ?? 0,
    };
  })()`;
  const response = await cdp.command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return (response.result?.result?.value as KeyframeRecoverySample | null) ?? null;
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
 *
 * `sourceSize` is the display the encoder captures, as each platform reports
 * it: physical pixels from `wm size` on Android, logical points from SimCtl on
 * iOS. Compare within a platform, not across one.
 */
async function captureProfile(): Promise<CaptureProfile> {
  // Android screenrecord follows the display refresh rate, which the pipeline
  // never configures; only the persistent encoder publishes a chosen fps.
  const usesVideoServer =
    Boolean(process.env.AUTOMOBILE_VIDEO_SERVER_JAR) || process.env.AUTOMOBILE_REQUIRE_VIDEO_SERVER === "1";
  // iOS WebRTC captures at the streaming default, which is deliberately separate
  // from the generic MCP-observation `SIMULATOR_FPS_DEFAULT` (5): the lane never
  // overrides AUTOMOBILE_WEBRTC_IOS_SIMULATOR_FPS, so the record must reflect the
  // rate the pipeline actually configures, not the observation constant (#4349).
  const configuredFps = platform === "android"
    ? (usesVideoServer ? ANDROID_VIDEO_SERVER_MEDIUM_FPS : null)
    : WEBRTC_IOS_SIMULATOR_FPS_DEFAULT;
  try {
    if (platform === "android") {
      const { stdout } = await execFileAsync("adb", ["-s", androidDeviceId(), "shell", "wm", "size"]);
      const match = /Physical size:\s*(\d+)x(\d+)/.exec(stdout);
      return { sourceSize: match ? { width: Number(match[1]), height: Number(match[2]) } : null, configuredFps };
    }
    // Not a hand-rolled `simctl io enumerate` regex: the first "Pixel Size:" in
    // that output belongs to the CarPlay screen, so a naive match reports
    // 720x480 for every simulator. SimCtlClient gates on the integrated display.
    const screen = await new SimCtlClient().getScreenSize("booted");
    return { sourceSize: { width: screen.width, height: screen.height }, configuredFps };
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
  // Measured as its own phase and swallowed: a cosmetic restore must be
  // attributable from the artifact (#4354) but must never fail an otherwise
  // passing run. The explicit hook timeout keeps bun's 5s default from firing;
  // the subprocess timeout kills a wedged simctl/adb before the budget is hit.
  await timeline
    .runPhase(
      "fixtureRestore",
      async () => {
        if (platform === "android") {
          const id = androidDeviceId();
          await execFileAsync("adb", ["-s", id, "shell", "cmd", "uimode", "night", "no"], {
            timeout: FIXTURE_RESTORE_TIMEOUT_MS,
          });
        }
        if (platform === "ios") {
          await execFileAsync("xcrun", ["simctl", "ui", "booted", "appearance", "light"], {
            timeout: FIXTURE_RESTORE_TIMEOUT_MS,
          });
        }
      },
      FIXTURE_RESTORE_TIMEOUT_MS
    )
    .catch(() => undefined);
}, TEARDOWN_HOOK_TIMEOUT_MS);

// Poll cadences the stages are observed with. Each measurement carries up to
// its interval as positive bias, so the record reports them rather than leaving
// a later percentile analysis to guess the error bar.
const STREAM_POLL_INTERVAL_MS = 100;
const SAMPLING_INTERVALS_MS: Partial<Record<CaptureStage, number>> = {
  whipConnected: STREAM_POLL_INTERVAL_MS,
  sourceStarted: STREAM_POLL_INTERVAL_MS,
  firstEncodedFrame: STREAM_POLL_INTERVAL_MS,
  whepConnected: STREAM_POLL_INTERVAL_MS,
  firstDecodedFrame: STREAM_POLL_INTERVAL_MS,
};

// Held at describe scope so the record survives a test timeout: bun skips the
// test body's `finally` when the deadline fires, but still runs afterAll. Losing
// exactly the slowest runs would bias the p95 this feeds (#4343) low.
const timeline = new CaptureStageTimeline();
let profile: CaptureProfile = { sourceSize: null, configuredFps: null };
let decodedSize: CaptureDimensions | null = null;
let egressKbps: number | null = null;
let decodedFps: number | null = null;
let outcome: "passed" | "failed" = "failed";
// Window over which egress bitrate and decoded fps are averaged, and the
// interval between the fixture toggles that keep the screen changing across it.
const EGRESS_WINDOW_MS = 2_000;
const EGRESS_TOGGLE_INTERVAL_MS = 400;
const STREAM_LEASE_HEARTBEAT_INTERVAL_MS = WEBRTC_STREAM_LEASE_TTL_MS / 3;

interface StreamLeaseHeartbeat {
  stop(): Promise<Error | null>;
}

/**
 * Device capture exercises startup, active streaming, and a recovery viewer for
 * longer than one stream lease. Keep the started stream owned for the duration
 * of the test, while still allowing the manager to reclaim abandoned streams.
 */
function startStreamLeaseHeartbeat(
  streamId: string,
  leaseId: string,
  socketPath: string,
  timer: Timer = defaultTimer
): StreamLeaseHeartbeat {
  let stopped = false;
  let failure: Error | null = null;
  let inFlight: Promise<void> | null = null;

  const renew = (): void => {
    if (stopped || failure || inFlight) {
      return;
    }
    inFlight = sendWebRtcStreamRequest(
      { action: "status", id: `${streamId}-lease-heartbeat`, streamId, leaseId },
      // Generous per-request budget: a keep-alive is not latency-sensitive and the
      // old 1s deadline flaked under macos-26 CI contention. Still far under the
      // TTL/3 renew interval, so it never overlaps the next tick.
      { socketPath, timeoutMs: 5_000 }
    ).then(response => {
      if (!response.success) {
        // The daemon actively REJECTED the renewal (lease expired or unknown) — a
        // genuine ownership loss, which is exactly what this heartbeat guards
        // against, so it is fatal.
        failure = new Error(`failed to renew WebRTC stream lease: ${response.error ?? "no error detail returned"}`);
      }
    }).catch((error: unknown) => {
      // A transient request timeout / socket hiccup is NOT a lease loss: the 60s
      // TTL spans several TTL/3 renews, so the next tick recovers and the stream is
      // never reclaimed within the test window. Logging instead of latching a
      // failure keeps a single contention blip from failing an otherwise-passing
      // run (both device lanes reached every stage — the flake was here).
      console.warn(
        `WebRTC stream lease renew attempt failed transiently (will retry next tick): ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
    }).finally(() => {
      inFlight = null;
    });
  };

  const interval = timer.setInterval(renew, STREAM_LEASE_HEARTBEAT_INTERVAL_MS);
  (interval as { unref?: () => void }).unref?.();
  return {
    async stop(): Promise<Error | null> {
      stopped = true;
      timer.clearInterval(interval);
      await inFlight;
      return failure;
    },
  };
}

describeIntegration("device capture -> WHIP -> MediaMTX -> WHEP (#4308)", () => {
  afterAll(async () => {
    const record = timeline.toRecord({
      platform: platform ?? "unknown",
      streamId,
      outcome,
      sourceSize: profile.sourceSize,
      configuredFps: profile.configuredFps,
      decodedSize,
      egressKbps,
      decodedFps,
      run: captureRunIdentity(),
      samplingIntervalsMs: SAMPLING_INTERVALS_MS,
    } satisfies CaptureStageContext);
    const summary = formatCaptureStageRecord(record);
    console.log(`[#4343] device capture stage latency\n${summary}`);
    // Written for passing runs too: the p50/p95 baselines this feeds need the
    // successful samples, and a failure keeps whatever stages it reached.
    await mkdir(artifactDir, { recursive: true });
    await writeFile(join(artifactDir, "stage-latency.json"), `${JSON.stringify(record, null, 2)}\n`);
    await writeFile(join(artifactDir, "result.txt"), `${summary}\n`);
  });

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
      // This test controls its Simulator fixture through simctl and does not
      // use CtrlProxy, so do not compete for the hosted runner with a release
      // download that is unrelated to capture -> WHIP -> WHEP.
      AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD: "1",
      // Opt this isolated, self-spawned daemon out of stream-socket session auth
      // (#4923). The guard requires every webrtcStream request to carry a
      // sessionUuid from a live daemon session; this harness talks to the socket
      // directly and never establishes one, so with the guard on EVERY probe is
      // rejected and `waitForWebRtcStreamSocket` times out — the deterministic
      // failure that has reddened both device lanes on every webrtc-touching PR
      // since the guard landed. The guard itself is covered by its own unit tests
      // (streamSocketAuth / socketServerHandshake); this lane's job is the
      // capture -> WHIP -> WHEP pipeline, so it uses the documented escape hatch.
      AUTOMOBILE_DAEMON_STREAM_AUTH: "0",
    };
    delete daemonEnvironment.AUTOMOBILE_DB_PATH;
    delete daemonEnvironment.AUTO_MOBILE_DB_PATH;
    const mediamtx = start(process.env.AUTOMOBILE_MEDIAMTX_BINARY, ["examples/mediamtx/mediamtx.yml"], join(artifactDir, "mediamtx.log"));
    let chrome: ChildProcessWithoutNullStreams | undefined;
    let cdp: CdpClient | undefined;
    let started = false;
    let observingStart = true;
    let startObserver: Promise<void> = Promise.resolve();
    let leaseHeartbeat: StreamLeaseHeartbeat | undefined;
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
      await startWebRtcDaemon(daemonEnvironment, webRtcSocketPath);
      await launchFixture();
      profile = await captureProfile();
      // Chrome is launched before the measured window opens so its cold start —
      // seconds on a hosted runner — is not charged to the WHEP-connect stage.
      ({ chrome, cdp } = await launchChromeReader(join(artifactDir, "chrome.log")));
      await ensureWebRtcDaemon(webRtcSocketPath, daemonEnvironment);
      timeline.mark("startRequest");
      // A video-only start returns as soon as the WHIP publish is accepted; the
      // capture source starts afterwards, so both transitions have to be
      // observed from a concurrent poller. `list` rather than `status` because
      // status throws (and the daemon logs an error) until the stream registers.
      // The poller never throws — a lost sample must not fail the lane, and
      // every wait below keeps its own timeout.
      startObserver = (async () => {
        while (observingStart && !(timeline.has("whipConnected") && timeline.has("sourceStarted"))) {
          const listed = await sendWebRtcStreamRequest(
            { action: "list", id: `${streamId}-start-observer` },
            { socketPath: webRtcSocketPath, timeoutMs: 1_000 }
          ).catch(() => undefined);
          const stream = listed?.streams?.find(candidate => candidate.streamId === streamId);
          if (stream?.state === "connected") {
            timeline.mark("whipConnected");
          }
          if (stream?.sourceStarted === true) {
            timeline.mark("sourceStarted");
          }
          await Bun.sleep(STREAM_POLL_INTERVAL_MS);
        }
      })();
      const response = await sendWebRtcStreamRequest(
        {
          action: "start",
          id: streamId,
          streamId,
          platform,
          whipEndpoint: `http://127.0.0.1:${webRtcPort}/${streamId}/whip`,
          // Both peers are local to the CI worker. Suppress the public STUN
          // default so host-candidate negotiation cannot depend on runner DNS.
          iceServers: [],
        },
        { socketPath: webRtcSocketPath }
      );
      if (!response.success) {
        throw new Error(`failed to start device WebRTC stream: ${response.error ?? "no error detail returned"}`);
      }
      const leaseId = response.stream?.lease?.id;
      if (!leaseId) {
        throw new Error("started device WebRTC stream did not return an ownership lease");
      }
      leaseHeartbeat = startStreamLeaseHeartbeat(streamId, leaseId, webRtcSocketPath);
      await waitFor(async () => {
        const status = await sendWebRtcStreamRequest(
          { action: "status", id: `${streamId}-capture-status`, streamId, leaseId },
          { socketPath: webRtcSocketPath, timeoutMs: 1_000 }
        ).catch(() => undefined);
        if ((status?.stream?.framesSent ?? 0) === 0) {
          return false;
        }
        timeline.mark("firstEncodedFrame");
        return true;
      }, "capture source did not deliver H.264 frames to the WHIP publisher");
      await subscribeReader(cdp);
      timeline.mark("whepConnected");
      // #4383: the screen has been static since capture started (fixture launched, no further
      // input), so this exercises a late viewer joining an idle stream. The encoder's
      // FrameHeartbeat must force a fresh surface submission — the periodic idle nudge plus a
      // keyframe nudge on the viewer's PLI — so the reader decodes with NO visible screen change.
      // On the pre-fix jar the reader sat black here indefinitely; this is the device coverage
      // #4383 asked for, and it fails on the old encoder while passing on the fixed one.
      await waitForDecodedFrames(cdp, 0, "browser did not decode device video on a static screen (late-viewer starvation, #4383)");
      timeline.mark("firstDecodedFrame");
      const staticScreenFrame = await videoSample(cdp);
      expect(staticScreenFrame.frames).toBeGreaterThan(0);
      decodedSize = { width: staticScreenFrame.width, height: staticScreenFrame.height };
      // A visible transition must still deliver changing video (regression guard for the
      // active-screen path that the idle-frame backstop must not disturb). Wait on decoded
      // CONTENT changing, not the frame count — the idle backstop advances the count on a static
      // screen, so a count-based wait would return on a forced repeat before the transition renders.
      await changeFixture();
      const first = await waitForChangedSample(cdp, staticScreenFrame, "browser did not decode changed video after a visible change");
      await launchFixture();
      // Changed content + frame progress are both enforced inside the bounded
      // waits (see waitForChangedSample) — asserting the counter on a one-shot
      // snapshot here raced the compositor and flaked (#4409).
      const second = await waitForChangedSample(cdp, first, "browser did not receive changed video after returning to the fixture");
      expect(first.width).toBeGreaterThan(0);
      expect(first.height).toBeGreaterThan(0);
      expect(second.sample).not.toBe(first.sample);
      // Measure the operating point the AC2 decision turns on (#4349): average
      // egress bitrate and decoded fps over a window while the stream is live.
      // Drive continuous visible change across the window rather than sampling a
      // static screen — H.264 inter-prediction compresses an idle fixture to
      // near-zero, which would under-report the active-screen egress this is
      // meant to capture (SimulatorCaptureSession also drops non-`.complete`
      // frames, so a still screen delivers far fewer than the configured fps).
      // Diagnostic only — a stats hiccup leaves both null and must never fail the
      // lane, so this asserts nothing about the values.
      try {
        const before = await egressSample(cdp);
        const windowDeadline = Date.now() + EGRESS_WINDOW_MS;
        while (Date.now() < windowDeadline) {
          await changeFixture();
          await Bun.sleep(EGRESS_TOGGLE_INTERVAL_MS);
          await launchFixture();
          await Bun.sleep(EGRESS_TOGGLE_INTERVAL_MS);
        }
        const after = await egressSample(cdp);
        if (before && after) {
          egressKbps = egressKbpsBetween(before, after);
          decodedFps = decodedFpsBetween(before, after);
        }
      } catch (error) {
        console.warn(`[#4349] could not sample egress bitrate / decoded fps: ${error}`);
      }
      // #4376: prove the on-demand keyframe path end-to-end. iOS only — the path
      // under a delivery shortfall is IosH264Source.requestKeyFrame (encoder
      // restart, PR #4374); AndroidH264Source has its own keyframe path, out of
      // scope here. Fresh viewer subscribing relays a PLI upstream through
      // MediaMTX to the WHIP publisher, which calls source.requestKeyFrame().
      if (platform === "ios") {
        await timeline.runPhase("keyframeRecovery", async () => {
          // A brand-new WHEP subscription is the relayed PLI: it renegotiates
          // with MediaMTX, which requests a keyframe upstream. The recovery
          // viewer starts cold, so its baseline is zero on both counters.
          ({ chrome, cdp } = await subscribeRecoveryReader(
            { chrome: chrome!, cdp: cdp! },
            join(artifactDir, "chrome.log")
          ));
          const baseline: KeyframeRecoverySample = { keyFramesDecoded: 0, framesDecoded: 0 };
          // Under a static Simulator screen the restarted encoder's IDR only
          // rides out on the next delivered frame (SimulatorCaptureSession drops
          // non-`.complete` frames), so keep driving a visible change and poll
          // for the fresh keyframe on that delivered frame — never a fixed
          // wall-clock sleep. The throttle floors one restart per
          // IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS; allow delivery slack on top so a
          // shortfall does not flake the lane.
          let recovered: KeyframeRecoverySample | null = null;
          let toggle = false;
          await waitFor(
            async () => {
              toggle = !toggle;
              await (toggle ? changeFixture() : launchFixture());
              const latest = await recoverySample(cdp!);
              if (latest && keyframeRecovered(baseline, latest)) {
                recovered = latest;
                return true;
              }
              return false;
            },
            `iOS WHEP viewer did not recover to a fresh IDR within ~${IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS}ms of the relayed PLI`,
            IOS_FORCED_KEYFRAME_MIN_INTERVAL_MS + 30_000
          );
          expect(recovered).not.toBeNull();
          expect(keyframeRecovered(baseline, recovered!)).toBe(true);
        });
      }
      const leaseHeartbeatError = await leaseHeartbeat.stop();
      leaseHeartbeat = undefined;
      if (leaseHeartbeatError) {
        throw leaseHeartbeatError;
      }
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
      observingStart = false;
      // Measured as its own phase (#4354) so a teardown that stalls stopping the
      // daemon, MediaMTX or Chrome is attributable from the artifact rather than
      // only from job logs. runPhase re-throws, preserving the prior semantics
      // where a failed cleanup surfaces as a test failure.
      await timeline.runPhase("pipelineTeardown", async () => {
        const leaseHeartbeatError = await leaseHeartbeat?.stop();
        if (leaseHeartbeatError) {
          console.warn(`WebRTC stream lease heartbeat failed during teardown: ${leaseHeartbeatError.message}`);
        }
        // Nothing in the observer rejects today; swallow anyway so a future edit
        // cannot skip the teardown below and replace the real test failure.
        await startObserver.catch(() => undefined);
        cdp?.close();
        await stop(chrome);
        if (started) {await execFileAsync("bun", ["dist/src/index.js", "--daemon", "stop"], { env: daemonEnvironment }).catch(() => undefined);}
        await stop(mediamtx);
        await rm(webRtcSocketDir, { recursive: true, force: true });
        // The daemon dir lives under the artifact dir and holds its logs and DB.
        // Now that artifacts upload on success too, keep it only for a failure to
        // triage; a green run should ship the latency record, not a sqlite file.
        if (outcome === "passed") {await rm(daemonDir, { recursive: true, force: true });}
      });
    }
  }, deviceIntegrationTimeoutMs);
});
