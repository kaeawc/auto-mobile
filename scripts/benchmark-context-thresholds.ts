#!/usr/bin/env bun
/**
 * Measure MCP context usage for the default core profile and the full tool
 * surface. Threshold enforcement is intentionally optional while baselines are
 * being established.
 *
 * Usage:
 *   bun scripts/benchmark-context-thresholds.ts [--config path/to/config.json] [--output path/to/report.json]
 */

import fs from "node:fs";
import path from "node:path";
import { Tiktoken } from "js-tiktoken/lite";
import cl100k_base from "js-tiktoken/ranks/cl100k_base";
import { ResourceRegistry } from "../src/server/resourceRegistry";
import { createMcpServer } from "../src/server/index";
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

export interface ThresholdConfig {
  version: string;
  metadata: {
    generatedAt?: string;
    description?: string;
    baseline: ContextMeasurements;
  };
  /** Add all six limits only after the recorded baselines have been reviewed. */
  thresholds?: ContextMeasurements;
}

export interface MeasurementResult {
  actual: number;
  baseline: number;
  delta: number;
  threshold?: number;
  passed?: boolean;
  usage?: number;
}

export interface BenchmarkReport {
  timestamp: string;
  passed: boolean;
  enforcement: { enabled: boolean };
  results: Record<ContextMeasurementKey, MeasurementResult>;
  baselines: ContextMeasurements;
  thresholds?: ContextMeasurements;
  violations: string[];
}

function estimateTokens(text: string): number {
  return tokenizer.encode(text).length;
}

function stripOutputSchema(tool: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(tool).filter(([key]) => key !== "outputSchema"));
}

function estimateDefinitions(
  definitions: readonly Record<string, unknown>[],
  stripOutputs = false,
): number {
  return definitions.reduce((total, definition) => {
    const measuredDefinition = stripOutputs ? stripOutputSchema(definition) : definition;
    return total + estimateTokens(JSON.stringify(measuredDefinition, null, 2));
  }, 0);
}

export function isCoreTool(toolName: string): boolean {
  return ToolRegistry.getRegisteredTool(toolName)?.defaultEnabled === true;
}

/**
 * Creates the normal MCP server so the benchmark cannot drift from production
 * registration as new tools or resources are added.
 */
export function collectContextMeasurements(): ContextMeasurements {
  createMcpServer({ daemonMode: true });

  const allTools = ToolRegistry.getToolDefinitions();
  const coreTools = allTools.filter((tool) => isCoreTool(tool.name));
  const resources = ResourceRegistry.getResourceDefinitions();
  const resourceTemplates = ResourceRegistry.getTemplateDefinitions();

  const coreToolsTokens = estimateDefinitions(coreTools, true);
  const allToolsTokens = estimateDefinitions(allTools, true);
  const resourceTokens = estimateDefinitions(resources);
  const resourceTemplateTokens = estimateDefinitions(resourceTemplates);

  return {
    coreTools: coreToolsTokens,
    allTools: allToolsTokens,
    resources: resourceTokens,
    resourceTemplates: resourceTemplateTokens,
    coreTotal: coreToolsTokens + resourceTokens + resourceTemplateTokens,
    allTotal: allToolsTokens + resourceTokens + resourceTemplateTokens,
  };
}

export function evaluateMeasurements(
  actuals: ContextMeasurements,
  config: ThresholdConfig,
): Omit<BenchmarkReport, "timestamp"> {
  const enforcementEnabled = config.thresholds !== undefined;
  const violations: string[] = [];
  const results = {} as Record<ContextMeasurementKey, MeasurementResult>;

  for (const key of CONTEXT_MEASUREMENT_KEYS) {
    const actual = actuals[key];
    const baseline = config.metadata.baseline[key];
    const threshold = config.thresholds?.[key];
    const passed = threshold === undefined ? undefined : actual <= threshold;
    if (passed === false) {
      violations.push(`${key}: ${actual} tokens exceeds threshold of ${threshold} tokens`);
    }
    results[key] = {
      actual,
      baseline,
      delta: actual - baseline,
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
    results,
    baselines: config.metadata.baseline,
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

  const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as ThresholdConfig;
  if (!config.metadata?.baseline) {
    throw new Error("Missing metadata.baseline section in configuration");
  }
  validateMeasurements(config.metadata.baseline, "baseline");
  if (config.thresholds !== undefined) {
    validateMeasurements(config.thresholds, "threshold");
  }
  return config;
}

export function runBenchmark(config: ThresholdConfig): BenchmarkReport {
  console.log("Initializing production MCP server components...");
  console.log("Measuring core and all-tool context usage...\n");
  return {
    timestamp: new Date().toISOString(),
    ...evaluateMeasurements(collectContextMeasurements(), config),
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
    return `  ${label.padEnd(25)} ${result.actual.toString().padStart(8)} ${result.baseline.toString().padStart(10)} ${formatDelta(result.delta).padStart(8)}  ${status}`;
  };

  console.log("Category                     Actual   Baseline    Delta  Status");
  console.log("-".repeat(96));
  console.log(formatRow("Core Tools", report.results.coreTools));
  console.log(formatRow("All Tools", report.results.allTools));
  console.log(formatRow("Resources", report.results.resources));
  console.log(formatRow("Resource Templates", report.results.resourceTemplates));
  console.log("-".repeat(96));
  console.log(formatRow("CORE TOTAL", report.results.coreTotal));
  console.log(formatRow("ALL TOTAL", report.results.allTotal));
  console.log("=".repeat(96));

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
  const report = runBenchmark(loadThresholdConfig(configPath));
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
