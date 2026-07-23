import { afterEach, describe, expect, test } from "bun:test";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { sendWebRtcStreamRequest } from "../../src/daemon/webrtcStreamClient";

const execFileAsync = promisify(execFile);
const runIntegration = process.env.AUTOMOBILE_WEBRTC_DEVICE_INTEGRATION === "1";
const describeIntegration = runIntegration ? describe : describe.skip;
const platform = process.env.AUTOMOBILE_WEBRTC_DEVICE_PLATFORM;
const webRtcPort = 8889;
const streamId = `device-capture-${platform ?? "unknown"}`;
const artifactDir = resolve("scratch/webrtc-device-integration");

interface ChromeTarget { type: string; webSocketDebuggerUrl?: string }
interface CdpResponse { id?: number; result?: { result?: { value?: unknown } }; error?: { message?: string } }

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
  child.stdout.on("data", chunk => writeFile(logFile, chunk, { flag: "a" }));
  child.stderr.on("data", chunk => writeFile(logFile, chunk, { flag: "a" }));
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
  await cdp.command("Page.navigate", { url: `http://127.0.0.1:${webRtcPort}/${streamId}` });
  return cdp;
}

async function videoSample(cdp: CdpClient): Promise<{ frames: number; width: number; height: number; sample: number }> {
  const expression = `(() => { const v = document.querySelector('video'); const q = v?.getVideoPlaybackQuality?.(); if (!v || !v.videoWidth) return {frames: 0, width: 0, height: 0, sample: 0}; const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let sum = 0; for (let i = 0; i < d.length; i += 97) sum = (sum + d[i] + d[i + 1] + d[i + 2]) >>> 0; return {frames: q?.totalVideoFrames ?? 0, width: v.videoWidth, height: v.videoHeight, sample: sum}; })()`;
  const response = await cdp.command("Runtime.evaluate", { expression, returnByValue: true });
  return response.result?.result?.value as { frames: number; width: number; height: number; sample: number };
}

async function launchFixture(): Promise<void> {
  if (platform === "android") {
    const id = process.env.AUTOMOBILE_ANDROID_H264_DEVICE_ID ?? "emulator-5554";
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
    const id = process.env.AUTOMOBILE_ANDROID_H264_DEVICE_ID ?? "emulator-5554";
    await execFileAsync("adb", ["-s", id, "shell", "cmd", "uimode", "night", "yes"]);
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
    const id = process.env.AUTOMOBILE_ANDROID_H264_DEVICE_ID ?? "emulator-5554";
    await execFileAsync("adb", ["-s", id, "shell", "cmd", "uimode", "night", "no"]).catch(() => undefined);
  }
  if (platform === "ios") {await execFileAsync("xcrun", ["simctl", "ui", "booted", "appearance", "light"]).catch(() => undefined);}
});

describeIntegration("device capture -> WHIP -> MediaMTX -> WHEP (#4308)", () => {
  test("the real device capture path renders changing video and stops cleanly", async () => {
    if (!process.env.AUTOMOBILE_MEDIAMTX_BINARY) {throw new Error("MediaMTX runner did not provide AUTOMOBILE_MEDIAMTX_BINARY");}
    await mkdir(artifactDir, { recursive: true });
    const daemonDbDir = await mkdtemp(join(artifactDir, "daemon-db-"));
    const daemonEnvironment = {
      ...process.env,
      AUTOMOBILE_DB_DIR: daemonDbDir,
      AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS: "60000",
    };
    delete daemonEnvironment.AUTOMOBILE_DB_PATH;
    const mediamtx = start(process.env.AUTOMOBILE_MEDIAMTX_BINARY, ["examples/mediamtx/mediamtx.yml"], join(artifactDir, "mediamtx.log"));
    let chrome: ChildProcessWithoutNullStreams | undefined;
    let cdp: CdpClient | undefined;
    let started = false;
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
          const response = await sendWebRtcStreamRequest({ action: "list", id: `${streamId}-daemon-ready` }, { timeoutMs: 1_000 });
          return response.success;
        } catch { return false; }
      }, "AutoMobile daemon did not become ready");
      await launchFixture();
      const response = await sendWebRtcStreamRequest({ action: "start", id: streamId, streamId, platform, whipEndpoint: `http://127.0.0.1:${webRtcPort}/${streamId}/whip` });
      expect(response.success).toBe(true);
      chrome = start(chromeBinary(), ["--headless=new", "--autoplay-policy=no-user-gesture-required", "--remote-debugging-port=9222", "--no-first-run", "about:blank"], join(artifactDir, "chrome.log"));
      cdp = await openReader(chrome);
      await waitFor(async () => (await videoSample(cdp!)).frames > 0, "browser did not decode device video");
      const first = await videoSample(cdp);
      await changeFixture();
      await Bun.sleep(1_500);
      const second = await videoSample(cdp);
      expect(first.width).toBeGreaterThan(0);
      expect(first.height).toBeGreaterThan(0);
      expect(second.frames).toBeGreaterThan(first.frames);
      expect(second.sample).not.toBe(first.sample);
      const stopped = await sendWebRtcStreamRequest({ action: "stop", id: `${streamId}-stop`, streamId });
      expect(stopped.success).toBe(true);
      const listed = await sendWebRtcStreamRequest({ action: "list", id: `${streamId}-list` });
      expect(listed.streams?.some(stream => stream.streamId === streamId)).toBe(false);
    } finally {
      cdp?.close();
      await stop(chrome);
      if (started) {await execFileAsync("bun", ["dist/src/index.js", "--daemon", "stop"], { env: daemonEnvironment }).catch(() => undefined);}
      await stop(mediamtx);
      await writeFile(join(artifactDir, "result.txt"), `platform=${platform}\nstream=${streamId}\n`);
    }
  }, 120_000);
});
