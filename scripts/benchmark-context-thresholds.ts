#!/usr/bin/env bun
/**
 * Measure MCP context usage for the default core profile and the full tool
 * surface. Tokens are counted on compact JSON, the form clients receive on the
 * wire; the pretty-printed (2-space) count is reported beside it for comparison
 * with older reports. Threshold enforcement is optional while baselines are
 * being established.
 *
 * Usage:
 *   bun scripts/benchmark-context-thresholds.ts [--config path/to/config.json] [--output path/to/report.json]
 */

import fs from "node:fs";
import path from "node:path";
import {
  InMemoryTransport,
  serializeMessage,
  type JSONRPCMessage,
} from "@modelcontextprotocol/server";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import { ResourceRegistry } from "../src/server/resourceRegistry";
import { createMcpServer, registerMcpTools } from "../src/server/index";
import { createProxyMcpServer } from "../src/server/proxyServer";
import { ToolRegistry } from "../src/server/toolRegistry";

const tokenizer = new Tiktoken(cl100k_base);

export const CONTEXT_MEASUREMENT_KEYS = [
  "coreTools",
  "allTools",
  "resources",
  "resourceTemplates",
  "coreTotal",
  "allTotal",
] as const;

export type ContextMeasurementKey = (typeof CONTEXT_MEASUREMENT_KEYS)[number];
export type ContextMeasurements = Record<ContextMeasurementKey, number>;

/**
 * The JSON form `baseline` and `thresholds` are counted on. Only compact JSON is
 * accepted, so a config recorded on pretty-printed counts (about 1.5x larger)
 * cannot be loaded and pass silently against smaller compact actuals.
 */
export const TOKEN_ENCODING = "compact-json";

/** Primary (compact) and secondary (pretty-printed) counts for one category. */
export interface ContextMeasurementSet {
  /** cl100k tokens of compact JSON: the gated metric. */
  compact: ContextMeasurements;
  /** UTF-8 bytes of compact JSON. */
  compactBytes: ContextMeasurements;
  /** cl100k tokens of `JSON.stringify(value, null, 2)`, kept for comparison only. */
  pretty: ContextMeasurements;
}

export interface ThresholdConfig {
  version: string;
  metadata: {
    generatedAt?: string;
    description?: string;
    /** Must be {@link TOKEN_ENCODING}. */
    tokenEncoding: string;
    baseline: ContextMeasurements;
    /** Pretty-printed counts, reported beside the compact ones; never gated. */
    prettyBaseline?: ContextMeasurements;
  };
  /** Add all six limits only after the recorded baselines have been reviewed. */
  thresholds?: ContextMeasurements;
}

export interface MeasurementResult {
  actual: number;
  baseline: number;
  delta: number;
  bytes: number;
  pretty: { actual: number; baseline?: number; delta?: number };
  threshold?: number;
  passed?: boolean;
  usage?: number;
}

/** A JSON payload's size as it travels over stdio. */
export interface WireSize {
  bytes: number;
  tokens: number;
}

/** The first `tools/list` a stdio client receives, measured on its serialized wire line. */
export interface StdioToolsListMeasurement {
  toolCount: number;
  /** The whole JSON-RPC response line, newline excluded. */
  response: WireSize;
  /** The compact `result.tools` array alone. */
  tools: WireSize;
}

export interface BenchmarkReport {
  timestamp: string;
  passed: boolean;
  enforcement: { enabled: boolean };
  tokenEncoding: string;
  results: Record<ContextMeasurementKey, MeasurementResult>;
  baselines: ContextMeasurements;
  prettyBaselines?: ContextMeasurements;
  thresholds?: ContextMeasurements;
  stdioToolsList?: StdioToolsListMeasurement;
  violations: string[];
}

function estimateTokens(text: string): number {
  return tokenizer.encode(text).length;
}

/** Bytes and tokens of `text` exactly as written. */
export function measureText(text: string): WireSize {
  return { bytes: Buffer.byteLength(text, "utf-8"), tokens: estimateTokens(text) };
}

/** Compact size (bytes and tokens) and pretty-printed tokens of one JSON value. */
export function measureJson(value: unknown): {
  compactBytes: number;
  compactTokens: number;
  prettyTokens: number;
} {
  const compact = measureText(JSON.stringify(value));
  return {
    compactBytes: compact.bytes,
    compactTokens: compact.tokens,
    prettyTokens: estimateTokens(JSON.stringify(value, null, 2)),
  };
}

function stripOutputSchema(tool: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(tool).filter(([key]) => key !== "outputSchema"));
}

interface DefinitionSize {
  compact: number;
  compactBytes: number;
  pretty: number;
}

/** Sums each definition's own size, so adding one tool moves only its own cost. */
export function estimateDefinitions(
  definitions: readonly Record<string, unknown>[],
  stripOutputs = false,
): DefinitionSize {
  return definitions.reduce<DefinitionSize>(
    (total, definition) => {
      const size = measureJson(stripOutputs ? stripOutputSchema(definition) : definition);
      return {
        compact: total.compact + size.compactTokens,
        compactBytes: total.compactBytes + size.compactBytes,
        pretty: total.pretty + size.prettyTokens,
      };
    },
    { compact: 0, compactBytes: 0, pretty: 0 },
  );
}

function measurementsFor(
  sizes: Record<"coreTools" | "allTools" | "resources" | "resourceTemplates", DefinitionSize>,
  field: keyof DefinitionSize,
): ContextMeasurements {
  const shared = sizes.resources[field] + sizes.resourceTemplates[field];
  return {
    coreTools: sizes.coreTools[field],
    allTools: sizes.allTools[field],
    resources: sizes.resources[field],
    resourceTemplates: sizes.resourceTemplates[field],
    coreTotal: sizes.coreTools[field] + shared,
    allTotal: sizes.allTools[field] + shared,
  };
}

export function isCoreTool(toolName: string): boolean {
  return ToolRegistry.getRegisteredTool(toolName)?.defaultEnabled === true;
}

/**
 * Creates the normal MCP server so the benchmark cannot drift from production
 * registration as new tools or resources are added.
 */
export function collectContextMeasurements(): ContextMeasurementSet {
  createMcpServer({ daemonMode: true });

  const allTools = ToolRegistry.getToolDefinitions();
  const coreTools = allTools.filter((tool) => isCoreTool(tool.name));
  const sizes = {
    coreTools: estimateDefinitions(coreTools, true),
    allTools: estimateDefinitions(allTools, true),
    resources: estimateDefinitions(ResourceRegistry.getResourceDefinitions()),
    resourceTemplates: estimateDefinitions(ResourceRegistry.getTemplateDefinitions()),
  };

  return {
    compact: measurementsFor(sizes, "compact"),
    compactBytes: measurementsFor(sizes, "compactBytes"),
    pretty: measurementsFor(sizes, "pretty"),
  };
}

/** Measure a serialized JSON-RPC `tools/list` response line (stdio framing, newline excluded). */
export function measureToolsListResponse(response: JSONRPCMessage): StdioToolsListMeasurement {
  const line = serializeMessage(response).replace(/\n$/, "");
  const result = "result" in response ? response.result : undefined;
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  return {
    toolCount: tools.length,
    response: measureText(line),
    tools: measureText(JSON.stringify(tools)),
  };
}

/** Registered only in daemon mode (`registerAllTools`). */
const DAEMON_ONLY_TOOL = "criticalSection";

function awaitResponse(transport: InMemoryTransport, id: number): Promise<JSONRPCMessage> {
  return new Promise((resolve) => {
    const previous = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if ("id" in message && message.id === id && !("method" in message)) {
        transport.onmessage = previous;
        resolve(message);
        return;
      }
      previous?.(message, extra);
    };
  });
}

/**
 * Capture the first `tools/list` a stdio client gets. The stdio entry point serves
 * through the daemon proxy, whose list before any daemon connection is the
 * committed static surface filtered by startup defaults. The proxy is built with
 * daemon auto-start off and is never connected, so no daemon is contacted.
 * Raw JSON-RPC is read off the in-memory transport (no client-side parsing, which
 * would reorder keys) and serialized with the SDK's stdio framing.
 *
 * Must run before any daemon-mode registration in this process: the stdio
 * process never registers daemon-only tools, and a registered one would change
 * the startup-default filter, so a stale registry is refused rather than measured.
 */
export async function measureStdioToolsList(): Promise<StdioToolsListMeasurement> {
  if (ToolRegistry.getRegisteredTool(DAEMON_ONLY_TOOL) !== undefined) {
    throw new Error(
      `measureStdioToolsList must run before daemon-mode registration (${DAEMON_ONLY_TOOL} is registered)`,
    );
  }
  // The stdio process registers the direct (non-daemon) tool surface.
  registerMcpTools(false);
  const { server, proxy } = createProxyMcpServer({ proxyConfig: { autoStartDaemon: false } });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await clientTransport.start();
    const initialized = awaitResponse(clientTransport, 1);
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "context-benchmark", version: "0.0.0" },
      },
    });
    await initialized;
    await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = awaitResponse(clientTransport, 2);
    await clientTransport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    return measureToolsListResponse(await listed);
  } finally {
    await clientTransport.close();
    await server.close();
    await proxy.close();
  }
}

export function evaluateMeasurements(
  actuals: ContextMeasurementSet,
  config: ThresholdConfig,
): Omit<BenchmarkReport, "timestamp" | "stdioToolsList"> {
  const enforcementEnabled = config.thresholds !== undefined;
  const violations: string[] = [];
  const results = {} as Record<ContextMeasurementKey, MeasurementResult>;
  const prettyBaselines = config.metadata.prettyBaseline;

  for (const key of CONTEXT_MEASUREMENT_KEYS) {
    const actual = actuals.compact[key];
    const baseline = config.metadata.baseline[key];
    const threshold = config.thresholds?.[key];
    const passed = threshold === undefined ? undefined : actual <= threshold;
    if (passed === false) {
      violations.push(`${key}: ${actual} tokens exceeds threshold of ${threshold} tokens`);
    }
    const prettyActual = actuals.pretty[key];
    const prettyBaseline = prettyBaselines?.[key];
    results[key] = {
      actual,
      baseline,
      delta: actual - baseline,
      bytes: actuals.compactBytes[key],
      pretty:
        prettyBaseline === undefined
          ? { actual: prettyActual }
          : {
              actual: prettyActual,
              baseline: prettyBaseline,
              delta: prettyActual - prettyBaseline,
            },
      ...(threshold === undefined
        ? {}
        : {
            threshold,
            passed,
            usage: Math.round((actual / threshold) * 100),
          }),
    };
  }

  return {
    passed: violations.length === 0,
    enforcement: { enabled: enforcementEnabled },
    tokenEncoding: TOKEN_ENCODING,
    results,
    baselines: config.metadata.baseline,
    ...(prettyBaselines === undefined ? {} : { prettyBaselines }),
    ...(config.thresholds === undefined ? {} : { thresholds: config.thresholds }),
    violations,
  };
}

function validateMeasurements(
  values: Partial<Record<ContextMeasurementKey, unknown>>,
  label: string,
): asserts values is ContextMeasurements {
  for (const key of CONTEXT_MEASUREMENT_KEYS) {
    if (typeof values[key] !== "number") {
      throw new Error(`Missing or invalid ${label}: ${key}`);
    }
  }
}

export function loadThresholdConfig(configPath: string): ThresholdConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Threshold configuration file not found: ${configPath}`);
  }

  return parseThresholdConfig(JSON.parse(fs.readFileSync(configPath, "utf-8")) as ThresholdConfig);
}

/** Validate a parsed config: compact-JSON encoding and every measurement present. */
export function parseThresholdConfig(config: ThresholdConfig): ThresholdConfig {
  if (!config.metadata?.baseline) {
    throw new Error("Missing metadata.baseline section in configuration");
  }
  if (config.metadata.tokenEncoding !== TOKEN_ENCODING) {
    throw new Error(
      `metadata.tokenEncoding must be "${TOKEN_ENCODING}" (found ${JSON.stringify(config.metadata.tokenEncoding)}): ` +
        "baselines and thresholds are counted on compact JSON. Re-record them from a fresh " +
        "`bun run benchmark-context` run instead of reusing pretty-printed counts.",
    );
  }
  validateMeasurements(config.metadata.baseline, "baseline");
  if (config.metadata.prettyBaseline !== undefined) {
    validateMeasurements(config.metadata.prettyBaseline, "pretty baseline");
  }
  if (config.thresholds !== undefined) {
    validateMeasurements(config.thresholds, "threshold");
  }
  return config;
}

export async function runBenchmark(config: ThresholdConfig): Promise<BenchmarkReport> {
  console.log("Initializing production MCP server components...");
  console.log("Measuring the stdio tools/list payload and core and all-tool context usage...\n");
  // The stdio surface first: the profile measurement registers daemon-mode tools.
  const stdioToolsList = await measureStdioToolsList();
  return {
    timestamp: new Date().toISOString(),
    ...evaluateMeasurements(collectContextMeasurements(), config),
    stdioToolsList,
  };
}

function formatDelta(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${delta.toLocaleString()}`;
}

export function printReport(report: BenchmarkReport): void {
  console.log("\n" + "=".repeat(96));
  console.log("MCP CONTEXT BASELINE BENCHMARK REPORT");
  console.log("=".repeat(96) + "\n");

  const formatRow = (label: string, result: MeasurementResult) => {
    const status = report.enforcement.enabled
      ? result.passed
        ? "✓ PASS"
        : "✗ FAIL"
      : "• BASELINE";
    const prettyDelta = result.pretty.delta === undefined ? "" : formatDelta(result.pretty.delta);
    return `  ${label.padEnd(25)} ${result.actual.toString().padStart(8)} ${result.baseline.toString().padStart(10)} ${formatDelta(result.delta).padStart(8)} ${result.bytes.toString().padStart(9)} ${result.pretty.actual.toString().padStart(9)} ${prettyDelta.padStart(8)}  ${status}`;
  };

  console.log(
    "Tokens are cl100k counts of compact JSON (the wire form); Pretty is 2-space JSON.\n",
  );
  console.log(
    "Category                     Actual   Baseline    Delta     Bytes    Pretty  P.Delta  Status",
  );
  console.log("-".repeat(96));
  console.log(formatRow("Core Tools", report.results.coreTools));
  console.log(formatRow("All Tools", report.results.allTools));
  console.log(formatRow("Resources", report.results.resources));
  console.log(formatRow("Resource Templates", report.results.resourceTemplates));
  console.log("-".repeat(96));
  console.log(formatRow("CORE TOTAL", report.results.coreTotal));
  console.log(formatRow("ALL TOTAL", report.results.allTotal));
  console.log("=".repeat(96));

  if (report.stdioToolsList) {
    const wire = report.stdioToolsList;
    console.log(
      `\nstdio tools/list (${wire.toolCount} tools): response line ${wire.response.bytes.toLocaleString()} B / ` +
        `${wire.response.tokens.toLocaleString()} tokens; tools array ${wire.tools.bytes.toLocaleString()} B / ` +
        `${wire.tools.tokens.toLocaleString()} tokens`,
    );
  }

  if (report.enforcement.enabled && report.violations.length > 0) {
    console.log("\nTHRESHOLD VIOLATIONS:");
    for (const violation of report.violations) {
      console.log(`  - ${violation}`);
    }
  }

  const status = report.enforcement.enabled
    ? report.passed
      ? "✓ PASSED"
      : "✗ FAILED"
    : "• BASELINES RECORDED (threshold enforcement pending)";
  console.log(`\nOverall Status: ${status}\n`);
}

function writeReportToFile(report: BenchmarkReport, outputPath: string): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`Benchmark report written to: ${outputPath}`);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let configPath = path.join(__dirname, "context-thresholds.json");
  let outputPath: string | undefined;

  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--config" && args[index + 1]) {
      configPath = args[++index];
    } else if (args[index] === "--output" && args[index + 1]) {
      outputPath = args[++index];
    }
  }

  console.log(`Loading context benchmark configuration from: ${configPath}\n`);
  const report = await runBenchmark(loadThresholdConfig(configPath));
  printReport(report);
  if (outputPath) {
    writeReportToFile(report, outputPath);
  }
  if (!report.passed) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exitCode = 1;
  });
}
