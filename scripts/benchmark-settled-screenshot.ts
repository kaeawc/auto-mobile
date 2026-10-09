#!/usr/bin/env bun
/**
 * Manual observe screenshot-mode benchmark with one full private daemon namespace
 * per run: lifecycle socket/PID/lock, auxiliary/WebRTC sockets, data/logs/DB and
 * launch cwd live in a unique short temp directory. Parent env is never mutated.
 * Each run selects an ephemeral loopback port and passes --port N --strict-port.
 * A guard rejects resident/default paths, ports and unsafe argv before each spawn.
 * SIGINT/SIGTERM and normal cleanup close MCP exactly once, then stop
 * only that namespace's daemon and remove the directory (retained on stop failure).
 * Failure reasons are reported in JSON/table; all-failed series are INVALID and
 * exit nonzero unless --allow-failures. A missing build fails before any child.
 * Device coordination remains shared. pressButton volume_up is valid on Android
 * and iOS; its observation uses the ambient policy, without a screenshot-mode arg.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { toActionableError } from "../src/models/ActionableError";
import {
  assertPrivateBenchmarkRunDir,
  buildPrivateBenchmarkLaunch,
  pickBenchmarkPort,
  stopPrivateDaemon,
  type BenchmarkLaunchOptions,
  type BenchmarkLaunchSafety,
} from "./benchmarkSettledScreenshotIsolation";
import { errorMessage } from "../src/utils/describeUnknownError";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  calculateMetrics,
  benchmarkExitCode,
  describeFailure,
  envelopeState,
  invalidSeriesNames,
  formatReportJson,
  formatReportTable,
  helpText,
  parseBenchmarkArgs,
  platformFromDeviceList,
  settledAsyncDelta,
  type BenchmarkReport,
  type ScreenshotMode,
} from "./benchmarkSettledScreenshotReport";
import {
  assertServerBuilt,
  buildBenchmarkChildEnv,
  type BenchmarkChildEnv,
} from "./benchmarkSettledScreenshotEnv";

export interface BenchmarkClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export interface BenchmarkDeps {
  createClient(options: BenchmarkLaunchOptions): Promise<BenchmarkClient>;
  pickPort(): Promise<number>;
  signals?: BenchmarkSignals;
  now(): number;
  log(message: string): void;
  write(path: string, content: string): void;
  makeRunDir(): string;
  removeRunDir(path: string): void;
  serverExists(path: string): boolean;
  stopPrivateDaemon(options: BenchmarkLaunchOptions): Promise<void>;
  parentEnv?: BenchmarkChildEnv;
  safety?: BenchmarkLaunchSafety;
}

export interface BenchmarkSignals {
  onTerminate(handler: (signal: "SIGINT" | "SIGTERM") => Promise<void>): () => void;
  exit(code: 130 | 143): void;
}

const MODES: ScreenshotMode[] = ["async", "settled", "none"];
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function observationPayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const observation = payload?.observation;
  return observation && typeof observation === "object"
    ? (observation as Record<string, unknown>)
    : payload;
}

export async function runBenchmark(
  options: ReturnType<typeof parseBenchmarkArgs>,
  deps: BenchmarkDeps,
): Promise<BenchmarkReport> {
  const serverPath = resolve(options.serverPath ?? resolve(repoRoot, "dist/src/index.js"));
  assertServerBuilt(serverPath, deps.serverExists(serverPath));
  const runDir = deps.makeRunDir();
  let launch: BenchmarkLaunchOptions | undefined;
  let client: BenchmarkClient | undefined;
  let childAttempted = false;
  let terminated = false;
  let releaseSetup: () => void = () => {};
  const setupDone = new Promise<void>((resolveSetup) => {
    releaseSetup = resolveSetup;
  });
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= setupDone.then(() =>
      cleanupBenchmark(client, launch, runDir, childAttempted, deps),
    );
    return cleanupPromise;
  };
  const unregister = deps.signals?.onTerminate(async (signal) => {
    if (terminated) {
      return;
    }
    terminated = true;
    await cleanup();
    deps.signals?.exit(signal === "SIGINT" ? 130 : 143);
  });
  const assertRunning = (): void => {
    if (terminated) {
      throw new Error("Benchmark terminated; private cleanup requested.");
    }
  };
  try {
    try {
      assertPrivateBenchmarkRunDir(runDir, deps.safety);
      const port = await deps.pickPort();
      assertRunning();
      const env = buildBenchmarkChildEnv(deps.parentEnv ?? process.env, runDir);
      launch = { serverPath, env, runDir, port };
      buildPrivateBenchmarkLaunch(launch, "client", deps.safety);
      childAttempted = true;
      client = await deps.createClient(launch);
    } finally {
      releaseSetup();
    }
    assertRunning();
    const connectedClient = client;
    const target = options.deviceId
      ? { deviceId: options.deviceId }
      : { platform: options.platform };
    const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      assertRunning();
      let envelope: unknown;
      try {
        envelope = await connectedClient.callTool(name, args);
      } catch (error) {
        const message = errorMessage(error).trim() || "failed with no error message";
        deps.log(`Warning: ${name} failed: ${message}`);
        envelope = { isError: true, content: [{ type: "text", text: message }] };
      }
      assertRunning();
      const state = envelopeState(envelope);
      if (state.parseError) {
        deps.log(`Warning: ${name} response JSON could not be parsed: ${state.parseError}`);
      }
      return envelope;
    };
    if (options.app) {
      const launch = await call("launchApp", { appId: options.app, ...target });
      if (envelopeState(launch).failed) {
        throw new Error(`launchApp failed for ${options.app}: ${describeFailure(launch)}`);
      }
    }
    const results: BenchmarkReport["results"] = { observe: {}, pressButton: {} };
    let detectedPlatform = options.platform ?? "unknown";
    if (options.deviceId && !options.platform) {
      const listed = envelopeState(await call("listDevices", {}));
      detectedPlatform =
        platformFromDeviceList(listed.payload, options.deviceId) ?? detectedPlatform;
      if (detectedPlatform === "unknown") {
        deps.log(`Warning: listDevices did not report a platform for ${options.deviceId}`);
      }
    }
    const measure = async (name: string, args: Record<string, unknown>, mode?: ScreenshotMode) => {
      const values: number[] = [];
      const failureMessages: string[] = [];
      let falseSettled = 0;
      for (let index = 0; index < options.warmup + options.iterations; index += 1) {
        const started = deps.now();
        const envelope = await call(name, args);
        const ms = deps.now() - started;
        const state = envelopeState(envelope);
        const observation = observationPayload(state.payload);
        if (typeof state.payload?.platform === "string") {
          detectedPlatform = state.payload.platform;
        }
        if (typeof observation?.platform === "string") {
          detectedPlatform = observation.platform;
        }
        if (index < options.warmup) {
          continue;
        }
        values.push(ms);
        if (state.failed) {
          failureMessages.push(describeFailure(envelope));
        }
        if (observation?.screenshotSettled === false && mode !== "none") {
          falseSettled += 1;
        }
      }
      return calculateMetrics(values, failureMessages.length, falseSettled, failureMessages);
    };
    for (const mode of MODES) {
      results.observe[mode] = await measure("observe", { screenshot: mode, ...target }, mode);
    }
    // Both platforms support volume_up. pressButton has no screenshot-mode argument.
    results.pressButton["ambient default"] = await measure("pressButton", {
      button: "volume_up",
      ...target,
    });
    const delta = settledAsyncDelta(results.observe.settled, results.observe.async);
    return {
      platform: detectedPlatform,
      deviceId: options.deviceId,
      generatedAt: new Date().toISOString(),
      iterations: options.iterations,
      warmup: options.warmup,
      actionMode: "ambient default, not mode-controlled",
      results,
      settledVsAsync: delta ? { observe: delta } : {},
    };
  } finally {
    try {
      await cleanup();
    } finally {
      unregister?.();
    }
  }
}

async function cleanupBenchmark(
  client: BenchmarkClient | undefined,
  launch: BenchmarkLaunchOptions | undefined,
  runDir: string,
  childAttempted: boolean,
  deps: BenchmarkDeps,
): Promise<void> {
  try {
    await client?.close();
  } catch (error) {
    deps.log(`Warning: MCP close failed for ${runDir}: ${errorMessage(error)}`);
  }
  if (childAttempted && launch) {
    try {
      buildPrivateBenchmarkLaunch(launch, "stop", deps.safety);
      await deps.stopPrivateDaemon(launch);
    } catch (error) {
      deps.log(`Warning: private daemon stop failed; retaining ${runDir}: ${errorMessage(error)}`);
      return;
    }
  }
  try {
    assertPrivateBenchmarkRunDir(runDir, deps.safety);
    deps.removeRunDir(runDir);
  } catch (error) {
    deps.log(`Warning: could not remove ${runDir}: ${errorMessage(error)}`);
  }
}

async function createSdkClient(options: BenchmarkLaunchOptions): Promise<BenchmarkClient> {
  const launch = buildPrivateBenchmarkLaunch(options, "client");
  const client = new Client({ name: "benchmark-settled-screenshot", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: launch.args,
    stderr: "inherit",
    env: launch.env,
  });
  try {
    await client.connect(transport);
  } catch (error) {
    try {
      await client.close();
    } catch (closeError) {
      console.warn(`Warning: failed MCP connection cleanup: ${errorMessage(closeError)}`);
    }
    throw toActionableError(error, "MCP connection failed; check the private daemon startup error");
  }
  return {
    callTool: (name, args) => client.callTool({ name, arguments: args }),
    close: () => client.close(),
  };
}

async function main(): Promise<void> {
  let options: ReturnType<typeof parseBenchmarkArgs>;
  try {
    options = parseBenchmarkArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `benchmark-settled-screenshot: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(helpText());
    return;
  }
  const deps: BenchmarkDeps = {
    createClient: createSdkClient,
    pickPort: pickBenchmarkPort,
    signals: {
      onTerminate: (handler) => {
        const interrupt = () => {
          // Keep duplicate signals trapped until idempotent cleanup completes.
          process.once("SIGINT", interrupt);
          void handler("SIGINT");
        };
        const terminate = () => {
          process.once("SIGTERM", terminate);
          void handler("SIGTERM");
        };
        process.once("SIGINT", interrupt);
        process.once("SIGTERM", terminate);
        return () => {
          process.removeListener("SIGINT", interrupt);
          process.removeListener("SIGTERM", terminate);
        };
      },
      exit: (code) => process.exit(code),
    },
    now: () => performance.now(),
    log: (message) => console.log(message),
    write: (path, content) => writeFileSync(path, content, "utf8"),
    serverExists: existsSync,
    stopPrivateDaemon,
    makeRunDir: () => mkdtempSync(join(tmpdir(), "am-bench-")),
    removeRunDir: (path) => rmSync(path, { recursive: true, force: true }),
  };
  try {
    const report = await runBenchmark(options, deps);
    const stamp = report.generatedAt.replace(/:/g, "-");
    const output = resolve(
      repoRoot,
      `scratch/benchmark-settled-screenshot-${report.platform}-${stamp}.json`,
    );
    mkdirSync(dirname(output), { recursive: true });
    deps.write(output, formatReportJson(report));
    deps.log(
      options.json
        ? formatReportJson(report)
        : `${formatReportTable(report)}\nFull JSON report: ${output}`,
    );
    process.exitCode = benchmarkExitCode(report, options);
    const invalid = invalidSeriesNames(report);
    if (invalid.length > 0) {
      console.error(
        `INVALID series (all calls failed): ${invalid.join(", ")}. Use --allow-failures to permit exit zero.`,
      );
    }
  } catch (error) {
    console.error(
      `benchmark-settled-screenshot: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  void main();
}
