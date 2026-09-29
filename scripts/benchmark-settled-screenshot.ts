#!/usr/bin/env bun
/**
 * Manual device benchmark for observe screenshot modes, ahead of issue #8042 PR 2.
 * It starts a fresh MCP child over stdio and gives it a unique auxiliary socket
 * directory in the OS temporary directory, so it cannot connect to or disturb ~/.auto-mobile
 * or /tmp/auto-mobile-daemon-* resident daemon sockets. The directory is removed
 * in finally. pressButton volume_up is the harmless action probe: volume keys
 * do not change app/window state. Its post-action observation uses the ambient
 * automatic screenshot policy; the action API does not accept screenshot mode.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  calculateMetrics,
  formatReportJson,
  formatReportTable,
  helpText,
  parseBenchmarkArgs,
  settledAsyncDelta,
  type BenchmarkReport,
  type Metrics,
  type ScreenshotMode,
} from "./benchmarkSettledScreenshotReport";

export interface BenchmarkClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
export interface BenchmarkDeps {
  createClient(serverPath: string, auxSocketDir: string): Promise<BenchmarkClient>;
  now(): number;
  log(message: string): void;
  write(path: string, content: string): void;
  makeAuxDir(): string;
  removeAuxDir(path: string): void;
}

const MODES: ScreenshotMode[] = ["async", "settled", "none"];
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function envelopeState(envelope: unknown): { failed: boolean; payload?: Record<string, unknown> } {
  const outer = envelope as
    | {
        isError?: boolean;
        structuredContent?: unknown;
        content?: Array<{ type?: string; text?: string }>;
      }
    | undefined;
  let payload =
    outer?.structuredContent && typeof outer.structuredContent === "object"
      ? (outer.structuredContent as Record<string, unknown>)
      : undefined;
  if (
    !payload &&
    outer?.content?.[0]?.type === "text" &&
    typeof outer.content[0].text === "string"
  ) {
    try {
      const parsed: unknown = JSON.parse(outer.content[0].text);
      if (parsed && typeof parsed === "object") {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Plain text tool responses have no structured payload; top-level isError remains authoritative.
    }
  }
  const failed = Boolean(outer?.isError || payload?.success === false || payload?.error);
  return { failed, payload };
}

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
  const oldAux = process.env.AUTOMOBILE_AUX_SOCKET_DIR;
  const auxDir = deps.makeAuxDir();
  process.env.AUTOMOBILE_AUX_SOCKET_DIR = auxDir;
  let client: BenchmarkClient | undefined;
  try {
    const serverPath = options.serverPath ?? resolve(repoRoot, "dist/src/index.js");
    client = await deps.createClient(serverPath, auxDir);
    const target = options.deviceId
      ? { deviceId: options.deviceId }
      : { platform: options.platform };
    if (options.app) {
      const launch = envelopeState(
        await client.callTool("launchApp", { appId: options.app, ...target }),
      );
      if (launch.failed) {
        throw new Error(`launchApp failed for ${options.app}.`);
      }
    }
    const results: BenchmarkReport["results"] = { observe: {}, pressButton: {} };
    let detectedPlatform = options.platform ?? "unknown";
    const sample = async (
      name: "observe" | "pressButton",
      args: Record<string, unknown>,
      mode: ScreenshotMode,
      keep: boolean,
    ): Promise<{ ms: number; failed: boolean; screenshotSettled: boolean | undefined }> => {
      const started = deps.now();
      const envelope = await client!.callTool(name, args);
      const ms = deps.now() - started;
      const state = envelopeState(envelope);
      const observation = observationPayload(state.payload);
      if (typeof state.payload?.platform === "string") {
        detectedPlatform = state.payload.platform;
      }
      if (typeof observation?.platform === "string") {
        detectedPlatform = observation.platform;
      }
      return {
        ms,
        failed: state.failed,
        screenshotSettled:
          typeof observation?.screenshotSettled === "boolean"
            ? observation.screenshotSettled
            : undefined,
      };
    };
    for (const mode of MODES) {
      const values: number[] = [];
      let failures = 0;
      let falseSettled = 0;
      for (let index = 0; index < options.warmup + options.iterations; index += 1) {
        const result = await sample(
          "observe",
          { screenshot: mode, ...target },
          mode,
          index >= options.warmup,
        );
        if (index < options.warmup) {
          continue;
        }
        values.push(result.ms);
        if (result.failed) {
          failures += 1;
        }
        if (result.screenshotSettled === false) {
          falseSettled += 1;
        }
      }
      results.observe[mode] = calculateMetrics(
        values,
        failures,
        mode === "none" ? 0 : falseSettled,
      );
    }
    // No screenshot mode parameter exists on pressButton; each call is explicitly
    // labeled as an ambient-default action measurement in the report.
    const action: number[] = [];
    let actionFailures = 0;
    let actionFalseSettled = 0;
    for (let index = 0; index < options.warmup + options.iterations; index += 1) {
      const result = await sample(
        "pressButton",
        { button: "volume_up", ...target },
        "async",
        index >= options.warmup,
      );
      if (index < options.warmup) {
        continue;
      }
      action.push(result.ms);
      if (result.failed) {
        actionFailures += 1;
      }
      if (result.screenshotSettled === false) {
        actionFalseSettled += 1;
      }
    }
    results.pressButton["ambient default"] = calculateMetrics(
      action,
      actionFailures,
      actionFalseSettled,
    );
    const report: BenchmarkReport = {
      platform: detectedPlatform,
      deviceId: options.deviceId,
      generatedAt: new Date().toISOString(),
      iterations: options.iterations,
      warmup: options.warmup,
      actionMode: "ambient default, not mode-controlled",
      results,
      settledVsAsync: {
        observe: settledAsyncDelta(
          results.observe.settled as Metrics,
          results.observe.async as Metrics,
        ),
      },
    };
    return report;
  } finally {
    try {
      if (client) {
        await client.close();
      }
    } finally {
      if (oldAux === undefined) {
        delete process.env.AUTOMOBILE_AUX_SOCKET_DIR;
      } else {
        process.env.AUTOMOBILE_AUX_SOCKET_DIR = oldAux;
      }
      deps.removeAuxDir(auxDir);
    }
  }
}

async function createSdkClient(serverPath: string, auxSocketDir: string): Promise<BenchmarkClient> {
  const client = new Client({ name: "benchmark-settled-screenshot", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    stderr: "inherit",
    env: { ...process.env, AUTOMOBILE_AUX_SOCKET_DIR: auxSocketDir },
  });
  await client.connect(transport);
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
    now: () => performance.now(),
    log: (message) => console.log(message),
    write: (path, content) => writeFileSync(path, content, "utf8"),
    makeAuxDir: () => mkdtempSync(join(tmpdir(), "benchmark-settled-screenshot-")),
    removeAuxDir: (path) => rmSync(path, { recursive: true, force: true }),
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
