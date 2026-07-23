import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { WebRtcPublisher } from "../../src/features/webrtc/WebRtcPublisher";

/**
 * Real SFU + decoder coverage for #4290. This is deliberately opt-in: it
 * spawns MediaMTX, FFmpeg, and a local Chrome instance, so it cannot be part of
 * the pure-logic test suite. Run `bun run test:integration:webrtc-mediamtx`.
 */
const RUN_INTEGRATION = process.env.AUTOMOBILE_MEDIAMTX_WEBRTC_INTEGRATION === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;
const STREAM_NAME = "automobile-integration";
const WEBRTC_PORT = 8889;
const MAX_LOG_CHARS = 8_000;

interface ChromeTarget {
  type: string;
  webSocketDebuggerUrl?: string;
}

interface CdpResponse {
  id?: number;
  result?: { result?: { value?: unknown } };
  error?: { message?: string };
}

interface DecodedVideo {
  width: number;
  height: number;
  decodedFrames: number;
}

interface StartedProcess {
  readonly process: ChildProcessWithoutNullStreams;
  readonly logs: () => string;
  readonly error: () => Error | undefined;
}

class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: CdpResponse) => void; reject: (error: Error) => void }>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString()) as CdpResponse;
      if (message.id === undefined) {
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(`Chrome DevTools error: ${message.error.message}`));
      } else {
        request.resolve(message);
      }
    });
    socket.on("close", () => {
      for (const request of this.pending.values()) {
        request.reject(new Error("Chrome DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await once(socket, "open");
    return new CdpClient(socket);
  }

  async command(method: string, params: Record<string, unknown> = {}): Promise<CdpResponse> {
    const id = this.nextId++;
    const response = new Promise<CdpResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  close(): void {
    this.socket.close();
  }
}

function appendLog(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString()}`.slice(-MAX_LOG_CHARS);
}

function startProcess(command: string, args: string[], cwd: string): StartedProcess {
  const process = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let spawnError: Error | undefined;
  process.stdout.on("data", chunk => {
    output = appendLog(output, chunk);
  });
  process.stderr.on("data", chunk => {
    output = appendLog(output, chunk);
  });
  process.on("error", error => {
    spawnError = error;
    output = appendLog(output, Buffer.from(`${error.message}\n`));
  });
  return { process, logs: () => output, error: () => spawnError };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs: number = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(100);
  }
  if (!(await predicate())) {
    throw new Error(message);
  }
}

function exitedProcessDescription(process: ChildProcessWithoutNullStreams): string | undefined {
  if (process.exitCode !== null) {
    return `exit code ${process.exitCode}`;
  }
  if (process.signalCode !== null) {
    return `signal ${process.signalCode}`;
  }
  return undefined;
}

async function waitForHttpServer(
  process: ChildProcessWithoutNullStreams,
  logs: () => string,
  url: string,
  name: string,
  processError?: () => Error | undefined,
): Promise<void> {
  await waitFor(async () => {
    const spawnError = processError?.();
    if (spawnError) {
      throw new Error(`${name} failed to start: ${spawnError.message}\n${logs()}`);
    }
    const exited = exitedProcessDescription(process);
    if (exited) {
      throw new Error(`${name} exited before readiness (${exited}):\n${logs()}`);
    }
    try {
      const response = await fetch(url);
      if (response.status >= 500) {
        return false;
      }
      await Bun.sleep(100);
      const exitedAfterProbe = exitedProcessDescription(process);
      if (exitedAfterProbe) {
        throw new Error(`${name} exited before readiness (${exitedAfterProbe}):\n${logs()}`);
      }
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.startsWith(`${name} exited before readiness`) || error.message.startsWith(`${name} failed to start`))
      ) {
        throw error;
      }
      return false;
    }
  }, `${name} did not start:\n${logs()}`);
}

async function stopProcess(process: ChildProcessWithoutNullStreams | undefined, graceMs: number = 3_000): Promise<void> {
  if (!process || process.pid === undefined || process.exitCode !== null || process.signalCode !== null) {
    return;
  }
  process.kill("SIGTERM");
  await Promise.race([
    once(process, "exit"),
    Bun.sleep(graceMs),
  ]);
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGKILL");
    await once(process, "exit");
  }
}

function resolveChromeBinary(): string {
  const configured = process.env.AUTOMOBILE_CHROME_BINARY;
  if (configured) {
    return configured;
  }
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const binary = candidates.find(existsSync);
  if (!binary) {
    throw new Error("Chrome is required; install it or set AUTOMOBILE_CHROME_BINARY");
  }
  return binary;
}

async function waitForChromeTarget(port: string): Promise<ChromeTarget> {
  let targets: ChromeTarget[] = [];
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await response.json() as ChromeTarget[];
      return targets.some(target => target.type === "page" && target.webSocketDebuggerUrl);
    } catch {
      return false;
    }
  }, "Chrome DevTools did not expose a page target");
  const target = targets.find(candidate => candidate.type === "page" && candidate.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("Chrome DevTools returned no debuggable page");
  }
  return target;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a loopback port for Chrome DevTools");
  }
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function openReader(chrome: ChildProcessWithoutNullStreams, debugPort: number): Promise<CdpClient> {
  if (chrome.exitCode !== null) {
    throw new Error(`Chrome exited before DevTools started (${chrome.exitCode})`);
  }
  const target = await waitForChromeTarget(String(debugPort));
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl!);
  await cdp.command("Page.enable");
  await cdp.command("Runtime.enable");
  await cdp.command("Page.navigate", { url: `http://127.0.0.1:${WEBRTC_PORT}/${STREAM_NAME}` });
  await waitFor(async () => {
    try {
      const response = await cdp.command("Runtime.evaluate", {
        expression: 'document.readyState === "complete" && document.querySelector("video") !== null',
        returnByValue: true,
      });
      return response.result?.result?.value === true;
    } catch {
      return false;
    }
  }, "Chrome did not load the MediaMTX reader page");
  return cdp;
}

async function readDecodedVideo(cdp: CdpClient): Promise<DecodedVideo> {
  const expression = `
    (async () => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const video = document.querySelector("video");
        const quality = video?.getVideoPlaybackQuality?.();
        if (video && video.videoWidth > 0 && video.videoHeight > 0 && (quality?.totalVideoFrames ?? 0) > 0) {
          return { width: video.videoWidth, height: video.videoHeight, decodedFrames: quality.totalVideoFrames };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const video = document.querySelector("video");
      const quality = video?.getVideoPlaybackQuality?.();
      return { width: video?.videoWidth ?? 0, height: video?.videoHeight ?? 0, decodedFrames: quality?.totalVideoFrames ?? 0 };
    })()
  `;
  const response = await cdp.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const value = response.result?.result?.value as DecodedVideo | undefined;
  if (!value) {
    throw new Error("Chrome did not return video playback quality");
  }
  return value;
}

test.skipIf(process.platform === "win32")("force-kills a child that ignores SIGTERM", async () => {
  const child = spawn("/bin/sh", ["-c", 'trap "" TERM; printf ready; while :; do sleep 1; done'], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await once(child.stdout, "data");

  await stopProcess(child, 10);

  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBe("SIGKILL");
});

test.skipIf(process.platform === "win32")("rejects a stale listener when the server child has already exited", async () => {
  const child = spawn("/bin/sh", ["-c", "exit 7"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  await once(child, "exit");

  await expect(waitForHttpServer(child, () => "address already in use", "http://127.0.0.1:8889/", "MediaMTX"))
    .rejects.toThrow("MediaMTX exited before readiness (exit code 7):\naddress already in use");
});

test.skipIf(process.platform === "win32")("captures a child spawn error for the test body", async () => {
  const started = startProcess(join(tmpdir(), "missing-mediamtx-test-binary"), [], tmpdir());

  await once(started.process, "error");

  expect(started.error()).toBeInstanceOf(Error);
  await stopProcess(started.process, 1);
  expect(started.process.pid).toBeUndefined();
});

describeIntegration("MediaMTX WebRTC publisher integration (#4290)", () => {
  test("publishes real H.264 through WHIP and Chrome decodes the MediaMTX WHEP reader", async () => {
    const mediamtxBinary = process.env.AUTOMOBILE_MEDIAMTX_BINARY;
    if (!mediamtxBinary) {
      throw new Error("AUTOMOBILE_MEDIAMTX_BINARY is required; use bun run test:integration:webrtc-mediamtx");
    }
    const repoRoot = resolve(import.meta.dir, "../..");
    const tempDir = await mkdtemp(join(tmpdir(), "automobile-mediamtx-"));
    const mediaMtx = startProcess(mediamtxBinary, [join(repoRoot, "examples/mediamtx/mediamtx.yml")], tempDir);
    let ffmpeg: ChildProcessWithoutNullStreams | undefined;
    let chrome: ChildProcessWithoutNullStreams | undefined;
    let cdp: CdpClient | undefined;
    const publisher = new WebRtcPublisher({
      streamId: STREAM_NAME,
      whipEndpoint: `http://127.0.0.1:${WEBRTC_PORT}/${STREAM_NAME}/whip`,
      maxReconnectAttempts: 1,
    });

    try {
      await waitForHttpServer(
        mediaMtx.process,
        mediaMtx.logs,
        `http://127.0.0.1:${WEBRTC_PORT}/`,
        "MediaMTX",
        mediaMtx.error,
      );

      await publisher.start();
      const ffmpegProcess = startProcess("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-re",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10",
        "-an", "-c:v", "libx264", "-profile:v", "baseline", "-level:v", "3.1",
        "-preset", "ultrafast", "-tune", "zerolatency", "-g", "10", "-keyint_min", "10",
        "-f", "h264", "pipe:1",
      ], tempDir);
      ffmpeg = ffmpegProcess.process;
      let ffmpegErrors = "";
      ffmpeg.stderr.on("data", chunk => {
        ffmpegErrors = appendLog(ffmpegErrors, chunk);
      });
      ffmpeg.stdout.on("data", chunk => publisher.writeH264Chunk(chunk));

      await waitFor(() => {
        const spawnError = ffmpegProcess.error();
        if (spawnError) {
          throw new Error(`FFmpeg failed to start: ${spawnError.message}`);
        }
        return publisher.getDescriptor().framesSent >= 10;
      }, "publisher did not send synthetic H.264 frames");
      const profileDir = join(tempDir, "chrome-profile");
      const debugPort = await reserveLoopbackPort();
      chrome = startProcess(resolveChromeBinary(), [
        "--headless=new", "--no-first-run", "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required", `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profileDir}`, "about:blank",
      ], tempDir).process;
      cdp = await openReader(chrome, debugPort);
      const decoded = await readDecodedVideo(cdp);

      expect(publisher.getDescriptor().framesSent).toBeGreaterThanOrEqual(10);
      expect(publisher.getDescriptor().packetsSent).toBeGreaterThan(0);
      expect(decoded.width).toBe(320);
      expect(decoded.height).toBe(240);
      expect(decoded.decodedFrames).toBeGreaterThan(0);
      expect(ffmpegErrors).toBe("");
    } finally {
      cdp?.close();
      await stopProcess(ffmpeg);
      await publisher.stop();
      await stopProcess(chrome);
      await stopProcess(mediaMtx.process);
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 90_000);
});
