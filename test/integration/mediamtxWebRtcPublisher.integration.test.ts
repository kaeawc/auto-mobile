import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { once, type EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { WebRtcPublisher } from "../../src/features/webrtc/WebRtcPublisher";
import { WhipClient } from "../../src/features/webrtc/WhipClient";
import { defaultTimer } from "../../src/utils/SystemTimer";

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
/**
 * A cold headless Chrome on a loaded Linux runner can take well over 20s before
 * it even writes its first stderr line (#17650), so the DevTools wait is
 * generous; each `/json/list` probe is individually bounded so one hung fetch
 * cannot overrun the deadline.
 */
const CHROME_TARGET_TIMEOUT_MS = 60_000;
const CHROME_PROBE_TIMEOUT_MS = 2_000;
const DEVTOOLS_BANNER = "DevTools listening on ";

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
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
  readonly logs: () => string;
  readonly error: () => Error | undefined;
}

class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: CdpResponse) => void; reject: (error: Error) => void }
  >();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => {
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
  process.stdout.on("data", (chunk) => {
    output = appendLog(output, chunk);
  });
  process.stderr.on("data", (chunk) => {
    output = appendLog(output, chunk);
  });
  process.on("error", (error) => {
    spawnError = error;
    output = appendLog(output, Buffer.from(`${error.message}\n`));
  });
  return { process, logs: () => output, error: () => spawnError };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string | (() => string),
  timeoutMs: number = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(100);
  }
  if (!(await predicate())) {
    throw new Error(typeof message === "function" ? message() : message);
  }
}

function exitedProcessDescription(
  process: ChildProcessByStdio<null, Readable, Readable>,
): string | undefined {
  if (process.exitCode !== null) {
    return `exit code ${process.exitCode}`;
  }
  if (process.signalCode !== null) {
    return `signal ${process.signalCode}`;
  }
  return undefined;
}

async function waitForHttpServer(
  process: ChildProcessByStdio<null, Readable, Readable>,
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
        (error.message.startsWith(`${name} exited before readiness`) ||
          error.message.startsWith(`${name} failed to start`))
      ) {
        throw error;
      }
      return false;
    }
  }, `${name} did not start:\n${logs()}`);
}

async function stopProcess(
  process: ChildProcessByStdio<null, Readable, Readable> | undefined,
  graceMs: number = 3_000,
): Promise<void> {
  if (
    !process ||
    process.pid === undefined ||
    process.exitCode !== null ||
    process.signalCode !== null
  ) {
    return;
  }
  process.kill("SIGTERM");
  await Promise.race([once(process, "exit"), Bun.sleep(graceMs)]);
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
  const candidates =
    process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const binary = candidates.find(existsSync);
  if (!binary) {
    throw new Error("Chrome is required; install it or set AUTOMOBILE_CHROME_BINARY");
  }
  return binary;
}

interface ChromeTargetTimeoutDetails {
  timeoutMs: number;
  elapsedMs: number;
  pid: number | undefined;
  lastProbe: string;
  logs: string;
}

/**
 * Distinguishes "Chrome never started its DevTools server" (slow or wedged
 * startup: no banner on stderr) from "DevTools is up but no page target
 * appeared", and always carries Chrome's stderr so the CI log is actionable.
 */
function describeChromeTargetTimeout(details: ChromeTargetTimeoutDetails): string {
  const devToolsState = details.logs.includes(DEVTOOLS_BANNER)
    ? "DevTools server started but exposed no debuggable page target"
    : "Chrome never printed its DevTools banner (startup did not finish)";
  return [
    `Chrome DevTools did not expose a page target within ${details.timeoutMs}ms ` +
      `(elapsed ${details.elapsedMs}ms, pid ${details.pid ?? "unknown"}, still running): ${devToolsState}.`,
    `Last /json/list probe: ${details.lastProbe}`,
    "Chrome stderr:",
    details.logs || "(empty)",
  ].join("\n");
}

async function probeChromeTargets(
  port: string,
): Promise<{ targets: ChromeTarget[] } | { failure: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(CHROME_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { failure: `HTTP ${response.status}` };
    }
    return { targets: (await response.json()) as ChromeTarget[] };
  } catch (error) {
    // Connection refused is the expected answer until Chrome binds the port.
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

async function waitForChromeTarget(port: string, chrome: StartedProcess): Promise<ChromeTarget> {
  const startedAt = Date.now();
  let targets: ChromeTarget[] = [];
  let lastProbe = "none completed";
  await waitFor(
    async () => {
      const spawnError = chrome.error();
      if (spawnError) {
        throw new Error(`Chrome failed to start: ${spawnError.message}\n${chrome.logs()}`);
      }
      const exited = exitedProcessDescription(chrome.process);
      if (exited) {
        throw new Error(`Chrome exited before DevTools started (${exited}):\n${chrome.logs()}`);
      }
      const probe = await probeChromeTargets(port);
      if ("failure" in probe) {
        lastProbe = probe.failure;
        return false;
      }
      targets = probe.targets;
      lastProbe = `${targets.length} target(s), types [${targets.map((t) => t.type).join(", ")}]`;
      return targets.some((target) => target.type === "page" && target.webSocketDebuggerUrl);
    },
    () =>
      describeChromeTargetTimeout({
        timeoutMs: CHROME_TARGET_TIMEOUT_MS,
        elapsedMs: Date.now() - startedAt,
        pid: chrome.process.pid,
        lastProbe,
        logs: chrome.logs(),
      }),
    CHROME_TARGET_TIMEOUT_MS,
  );
  const target = targets.find(
    (candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl,
  );
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("Chrome DevTools returned no debuggable page");
  }
  return target;
}

/**
 * Headless Chrome flags. Beyond the DevTools/profile essentials, the
 * `--disable-*` set skips first-run background work (component updater,
 * sync, extensions, default apps, keychain) that lengthens a cold start on a
 * loaded runner without affecting WebRTC decode.
 */
function chromeArgs(debugPort: number, profileDir: string): string[] {
  return [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--password-store=basic",
    "--use-mock-keychain",
    "--autoplay-policy=no-user-gesture-required",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ];
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
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function openReader(chrome: StartedProcess, debugPort: number): Promise<CdpClient> {
  if (chrome.process.exitCode !== null) {
    throw new Error(`Chrome exited before DevTools started (${chrome.process.exitCode})`);
  }
  const target = await waitForChromeTarget(String(debugPort), chrome);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl!);
  await cdp.command("Page.enable");
  await cdp.command("Runtime.enable");
  await cdp.command("Page.navigate", { url: `http://127.0.0.1:${WEBRTC_PORT}/${STREAM_NAME}` });
  await waitFor(async () => {
    try {
      const response = await cdp.command("Runtime.evaluate", {
        expression:
          'document.readyState === "complete" && document.querySelector("video") !== null',
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
  const response = await cdp.command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = response.result?.result?.value as DecodedVideo | undefined;
  if (!value) {
    throw new Error("Chrome did not return video playback quality");
  }
  return value;
}

/**
 * Bound a wait on a real child-process event: these three helper tests run in
 * the DEFAULT `bun test` suite on macOS/Linux (only win32 is skipped), so an
 * unbounded `once()` on a child that never emits would ride the whole CI
 * wall-clock watchdog (#5391) instead of failing with a diagnostic.
 */
async function boundedOnce(
  emitter: EventEmitter,
  event: string,
  description: string,
  timeoutMs: number = 10_000,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = defaultTimer.setTimeout(
      () =>
        reject(
          new Error(
            `${description} did not emit '${event}' within ${timeoutMs}ms — bounded real-I/O deadline hit`,
          ),
        ),
      timeoutMs,
    );
  });
  try {
    await Promise.race([once(emitter, event), deadline]);
  } finally {
    if (timer !== undefined) {
      defaultTimer.clearTimeout(timer);
    }
  }
}

test.skipIf(process.platform === "win32")("force-kills a child that ignores SIGTERM", async () => {
  const child = spawn("/bin/sh", ["-c", 'trap "" TERM; printf ready; while :; do sleep 1; done'], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await boundedOnce(child.stdout, "data", "SIGTERM-ignoring child stdout");

    await stopProcess(child, 10);

    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGKILL");
  } finally {
    // Guaranteed teardown even when an assertion or the deadline throws: a
    // surviving `while :; do sleep 1; done` child would leak past the suite.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

test.skipIf(process.platform === "win32")(
  "rejects a stale listener when the server child has already exited",
  async () => {
    const child = spawn("/bin/sh", ["-c", "exit 7"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await boundedOnce(child, "exit", "immediately-exiting child");

      await expect(
        waitForHttpServer(
          child,
          () => "address already in use",
          "http://127.0.0.1:8889/",
          "MediaMTX",
        ),
      ).rejects.toThrow("MediaMTX exited before readiness (exit code 7):\naddress already in use");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  },
);

test.skipIf(process.platform === "win32")(
  "captures a child spawn error for the test body",
  async () => {
    const started = startProcess(join(tmpdir(), "missing-mediamtx-test-binary"), [], tmpdir());

    await boundedOnce(started.process, "error", "missing-binary spawn");

    expect(started.error()).toBeInstanceOf(Error);
    await stopProcess(started.process, 1);
    expect(started.process.pid).toBeUndefined();
  },
);

test("Chrome target timeout says DevTools never started and carries Chrome stderr", () => {
  const message = describeChromeTargetTimeout({
    timeoutMs: 60_000,
    elapsedMs: 60_012,
    pid: 3727,
    lastProbe: "Unable to connect",
    logs: "ERROR:dbus/bus.cc:405] Failed to connect to the bus\n",
  });

  expect(message).toContain("within 60000ms (elapsed 60012ms, pid 3727, still running)");
  expect(message).toContain("Chrome never printed its DevTools banner");
  expect(message).toContain("Last /json/list probe: Unable to connect");
  expect(message).toContain("Chrome stderr:\nERROR:dbus/bus.cc:405] Failed to connect to the bus");
});

test("Chrome target timeout says DevTools started when the banner is present", () => {
  const message = describeChromeTargetTimeout({
    timeoutMs: 60_000,
    elapsedMs: 60_000,
    pid: undefined,
    lastProbe: "1 target(s), types [browser]",
    logs: "DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc\n",
  });

  expect(message).toContain("pid unknown");
  expect(message).toContain("DevTools server started but exposed no debuggable page target");
  expect(message).not.toContain("never printed");
});

describeIntegration("MediaMTX WebRTC publisher integration (#4290)", () => {
  test("trickles candidates across a reconnect and Chrome decodes both WHEP sessions", async () => {
    const mediamtxBinary = process.env.AUTOMOBILE_MEDIAMTX_BINARY;
    if (!mediamtxBinary) {
      throw new Error(
        "AUTOMOBILE_MEDIAMTX_BINARY is required; use bun run test:integration:webrtc-mediamtx",
      );
    }
    const repoRoot = resolve(import.meta.dir, "../..");
    const tempDir = await mkdtemp(join(tmpdir(), "automobile-mediamtx-"));
    const mediaMtx = startProcess(
      mediamtxBinary,
      [join(repoRoot, "examples/mediamtx/mediamtx.yml")],
      tempDir,
    );
    let ffmpeg: ChildProcessByStdio<null, Readable, Readable> | undefined;
    let chrome: StartedProcess | undefined;
    let cdp: CdpClient | undefined;
    const patchedResources: string[] = [];
    const publisher = new WebRtcPublisher(
      {
        streamId: STREAM_NAME,
        whipEndpoint: `http://127.0.0.1:${WEBRTC_PORT}/${STREAM_NAME}/whip`,
        maxReconnectAttempts: 1,
        trickleIce: true,
      },
      {
        createWhipClient: (options) => {
          const client = new WhipClient(options);
          const patchCandidate = client.patchCandidate.bind(client);
          client.patchCandidate = async (resourceUrl, etag, fragment, signal) => {
            await patchCandidate(resourceUrl, etag, fragment, signal);
            patchedResources.push(resourceUrl);
          };
          return client;
        },
      },
    );

    try {
      await waitForHttpServer(
        mediaMtx.process,
        mediaMtx.logs,
        `http://127.0.0.1:${WEBRTC_PORT}/`,
        "MediaMTX",
        mediaMtx.error,
      );

      await publisher.start();
      const initialResourceUrl = publisher.getDescriptor().resourceUrl;
      if (!initialResourceUrl) {
        throw new Error("WHIP ingest did not return a resource URL for candidate trickling");
      }
      await waitFor(
        () => patchedResources.includes(initialResourceUrl),
        "MediaMTX did not receive a trickled candidate for the initial WHIP resource",
      );
      const ffmpegProcess = startProcess(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-re",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x240:rate=10",
          "-an",
          "-c:v",
          "libx264",
          "-profile:v",
          "baseline",
          "-level:v",
          "3.1",
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-g",
          "10",
          "-keyint_min",
          "10",
          "-f",
          "h264",
          "pipe:1",
        ],
        tempDir,
      );
      ffmpeg = ffmpegProcess.process;
      let ffmpegErrors = "";
      ffmpeg.stderr.on("data", (chunk) => {
        ffmpegErrors = appendLog(ffmpegErrors, chunk);
      });
      ffmpeg.stdout.on("data", (chunk) => publisher.writeH264Chunk(chunk));

      await waitFor(() => {
        const spawnError = ffmpegProcess.error();
        if (spawnError) {
          throw new Error(`FFmpeg failed to start: ${spawnError.message}`);
        }
        return publisher.getDescriptor().framesSent >= 10;
      }, "publisher did not send synthetic H.264 frames");
      const profileDir = join(tempDir, "chrome-profile");
      const debugPort = await reserveLoopbackPort();
      chrome = startProcess(resolveChromeBinary(), chromeArgs(debugPort, profileDir), tempDir);
      cdp = await openReader(chrome, debugPort);
      const decoded = await readDecodedVideo(cdp);

      expect(publisher.getDescriptor().framesSent).toBeGreaterThanOrEqual(10);
      expect(publisher.getDescriptor().packetsSent).toBeGreaterThan(0);
      expect(decoded.width).toBe(320);
      expect(decoded.height).toBe(240);
      expect(decoded.decodedFrames).toBeGreaterThan(0);

      // A reconnect must create a new WHIP resource, send candidates to that
      // resource after it exists, and keep MediaMTX's WHEP fan-out decodable.
      publisher.notifySourceFailed(new Error("integration reconnect"));
      let reconnectedResourceUrl = "";
      await waitFor(() => {
        const resourceUrl = publisher.getDescriptor().resourceUrl;
        if (
          !resourceUrl ||
          resourceUrl === initialResourceUrl ||
          !patchedResources.includes(resourceUrl)
        ) {
          return false;
        }
        reconnectedResourceUrl = resourceUrl;
        return publisher.getState() === "connected";
      }, "publisher did not reconnect with a trickled candidate on its replacement WHIP resource");
      expect(reconnectedResourceUrl).not.toBe(initialResourceUrl);

      cdp.close();
      cdp = undefined;
      await stopProcess(chrome.process);
      chrome = undefined;
      const reconnectDebugPort = await reserveLoopbackPort();
      chrome = startProcess(
        resolveChromeBinary(),
        chromeArgs(reconnectDebugPort, join(tempDir, "chrome-reconnect-profile")),
        tempDir,
      );
      cdp = await openReader(chrome, reconnectDebugPort);
      const recovered = await readDecodedVideo(cdp);
      expect(recovered.width).toBe(320);
      expect(recovered.height).toBe(240);
      expect(recovered.decodedFrames).toBeGreaterThan(0);
      expect(ffmpegErrors).toBe("");
    } finally {
      cdp?.close();
      await stopProcess(ffmpeg);
      await publisher.stop();
      await stopProcess(chrome?.process);
      await stopProcess(mediaMtx.process);
      await rm(tempDir, { recursive: true, force: true });
    }
    // Two cold Chrome launches (each up to CHROME_TARGET_TIMEOUT_MS), two page
    // loads and two 20s decode reads must fit; the job's own timeout is 20min.
  }, 240_000);
});
