#!/usr/bin/env bun
/**
 * Benchmark script to enforce NPM unpacked size thresholds.
 *
 * Usage:
 *   bun scripts/benchmark-npm-unpacked-size.ts [--config path/to/config.json] [--output path/to/report.json]
 *
 * Options:
 *   --config    Path to threshold configuration file (default: scripts/npm-unpacked-size-thresholds.json)
 *   --output    Path to write JSON report file (optional)
 *
 * Exit codes:
 *   0 - Threshold satisfied
 *   1 - Threshold exceeded or error occurred
 */

import fs from "node:fs";
import path from "node:path";
import { findPackedAssetViolations } from "./build/packed-runtime-assets";

const DEFAULT_CONFIG_PATH = path.join("scripts", "npm-unpacked-size-thresholds.json");
const REQUIRED_DIST_ENTRY = path.join("dist", "src", "index.js");

interface ThresholdConfig {
  version: string;
  thresholds: {
    unpackedBytes: number;
    warnHeadroomBytes?: number;
  };
  metadata?: {
    generatedAt?: string;
    description?: string;
  };
}

interface CategoryResult {
  actual: number;
  threshold: number;
  passed: boolean;
  usage: number;
}

interface UnpackedSizeResult extends CategoryResult {
  headroomBytes: number;
  headroomPercent: number;
  warning: boolean;
  warnHeadroomBytes?: number;
}

interface SizeEvaluation {
  passed: boolean;
  results: {
    unpackedSize: UnpackedSizeResult;
  };
  thresholds: ThresholdConfig["thresholds"];
  package: {
    largestFiles: { path: string; size: number }[];
  };
  violations: string[];
  warnings: string[];
}

interface BenchmarkReport extends SizeEvaluation {
  timestamp: string;
  package: SizeEvaluation["package"] & {
    name: string;
    version: string;
    filename: string | null;
    tarballBytes: number | null;
    unpackedBytes: number;
  };
}

interface CliOptions {
  configPath: string;
  outputPath: string | null;
}

const decoder = new TextDecoder();

function parseArgs(args: string[]): CliOptions {
  let configPath = DEFAULT_CONFIG_PATH;
  let outputPath: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--config": {
        const value = args[i + 1];
        if (!value) {
          console.error("Missing value for --config");
          process.exit(1);
        }
        configPath = value;
        i += 1;
        break;
      }
      case "--output": {
        const value = args[i + 1];
        if (!value) {
          console.error("Missing value for --output");
          process.exit(1);
        }
        outputPath = value;
        i += 1;
        break;
      }
      default: {
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
      }
    }
  }

  return { configPath, outputPath };
}

function decodeOutput(output: Uint8Array | null): string {
  if (!output) {
    return "";
  }
  return decoder.decode(output);
}

export function trimmedPackEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...env, AUTOMOBILE_TRIM_BUNDLED_DEPS: "true" };
}

function runCommand(
  cmd: string[],
  allowFailure = false,
  env?: Record<string, string | undefined>,
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync({
    cmd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = decodeOutput(result.stdout);
  const stderr = decodeOutput(result.stderr);

  if (result.exitCode !== 0 && !allowFailure) {
    let message = `Command failed: ${cmd.join(" ")}`;
    if (stdout.trim()) {
      message += `\nstdout:\n${stdout.trim()}`;
    }
    if (stderr.trim()) {
      message += `\nstderr:\n${stderr.trim()}`;
    }
    throw new Error(message);
  }

  return { stdout, stderr, exitCode: result.exitCode };
}

function loadThresholdConfig(configPath: string): ThresholdConfig {
  if (!fs.existsSync(configPath)) {
    console.error(`Threshold configuration file not found: ${configPath}`);
    process.exit(1);
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return validateThresholdConfig(JSON.parse(content));
  } catch (error) {
    console.error(`Error loading threshold configuration: ${error}`);
    process.exit(1);
  }
}

export function validateThresholdConfig(value: unknown): ThresholdConfig {
  const config = value as ThresholdConfig;
  if (!config?.thresholds || typeof config.thresholds.unpackedBytes !== "number") {
    throw new Error("Missing or invalid unpackedBytes threshold");
  }
  const warning = config.thresholds.warnHeadroomBytes;
  if (
    warning !== undefined &&
    (typeof warning !== "number" || !Number.isFinite(warning) || warning < 0)
  ) {
    throw new Error("Invalid warnHeadroomBytes threshold");
  }
  return config;
}

export function evaluateUnpackedSize({
  unpackedBytes,
  files,
  thresholds,
}: {
  unpackedBytes: number;
  files: readonly { path: string; size: number }[];
  thresholds: ThresholdConfig["thresholds"];
}): SizeEvaluation {
  const size = checkThreshold(unpackedBytes, thresholds.unpackedBytes);
  const headroomBytes = thresholds.unpackedBytes - unpackedBytes;
  // One decimal place; a zero/non-positive cap has no meaningful percentage.
  const headroomPercent =
    thresholds.unpackedBytes > 0
      ? Math.round((headroomBytes / thresholds.unpackedBytes) * 1000) / 10
      : 0;
  const warning =
    size.passed &&
    thresholds.warnHeadroomBytes !== undefined &&
    headroomBytes < thresholds.warnHeadroomBytes;
  const violations = findPackedAssetViolations(files.map((file) => file.path));
  if (!size.passed) {
    violations.push(
      `Unpacked size ${unpackedBytes} bytes exceeds threshold ${thresholds.unpackedBytes} bytes`,
    );
  }
  const passed = violations.length === 0;
  const largestFiles =
    warning || !passed
      ? files
          .map(({ path, size }) => ({ path, size }))
          .sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .slice(0, 10)
      : [];
  return {
    passed,
    results: {
      unpackedSize: {
        ...size,
        headroomBytes,
        headroomPercent,
        warning,
        warnHeadroomBytes: thresholds.warnHeadroomBytes,
      },
    },
    thresholds,
    package: { largestFiles },
    violations,
    warnings: warning
      ? [
          `WARNING: npm unpacked size headroom ${headroomBytes} bytes (${headroomPercent}%) is below the ${thresholds.warnHeadroomBytes} byte warning threshold; the ${thresholds.unpackedBytes} byte cap blocks every PR when exceeded`,
        ]
      : [],
  };
}

function checkThreshold(actual: number, threshold: number): CategoryResult {
  const passed = actual <= threshold;
  const usage = threshold > 0 ? Math.round((actual / threshold) * 100) : 0;

  return {
    actual,
    threshold,
    passed,
    usage,
  };
}

function ensureBuildOutput(): void {
  if (!fs.existsSync(REQUIRED_DIST_ENTRY)) {
    console.error(`Build output not found: ${REQUIRED_DIST_ENTRY}`);
    console.error("Run 'bun run build' before benchmarking unpacked size.");
    process.exit(1);
  }
}

export function parsePackOutput(stdout: string): {
  name: string;
  version: string;
  filename: string | null;
  tarballBytes: number | null;
  unpackedBytes: number;
  files: { path: string; size: number; mode: number }[];
} {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("npm pack returned empty output");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Failed to parse npm pack output: ${error}`);
  }

  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("npm pack output did not include package details");
  }

  const packResult = payload[0] as {
    name?: string;
    version?: string;
    filename?: string;
    size?: number;
    unpackedSize?: number;
    files?: { path: string; size: number; mode: number }[];
  };

  if (typeof packResult.unpackedSize !== "number") {
    throw new Error("npm pack output missing unpackedSize");
  }

  if (
    !Array.isArray(packResult.files) ||
    !packResult.files.every(
      (file) =>
        file !== null &&
        typeof file === "object" &&
        typeof file.path === "string" &&
        typeof file.size === "number" &&
        typeof file.mode === "number",
    )
  ) {
    throw new Error("npm pack output missing or invalid files manifest");
  }

  return {
    name: packResult.name ?? "unknown",
    version: packResult.version ?? "unknown",
    filename: packResult.filename ?? null,
    tarballBytes: typeof packResult.size === "number" ? packResult.size : null,
    unpackedBytes: packResult.unpackedSize,
    files: packResult.files,
  };
}

function writeReport(outputPath: string, report: BenchmarkReport): void {
  const dir = path.dirname(outputPath);
  if (dir && dir !== ".") {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
}

function runBenchmark(config: ThresholdConfig, outputPath: string | null): BenchmarkReport {
  ensureBuildOutput();

  let packFilename: string | null = null;

  try {
    runCommand(["bun", "run", "prepublishOnly"]);

    const packResult = runCommand(["npm", "pack", "--json"], false, trimmedPackEnv(process.env));
    const packInfo = parsePackOutput(packResult.stdout);
    packFilename = packInfo.filename;

    const evaluation = evaluateUnpackedSize({ ...packInfo, thresholds: config.thresholds });
    const report: BenchmarkReport = {
      ...evaluation,
      timestamp: new Date().toISOString(),
      package: {
        name: packInfo.name,
        version: packInfo.version,
        filename: packInfo.filename,
        tarballBytes: packInfo.tarballBytes,
        unpackedBytes: packInfo.unpackedBytes,
        largestFiles: evaluation.package.largestFiles,
      },
    };

    if (outputPath) {
      writeReport(outputPath, report);
    }

    const result = report.results.unpackedSize;
    const lines = [
      `NPM unpacked size: ${result.actual} bytes (threshold: ${result.threshold} bytes; headroom: ${result.headroomBytes} bytes (${result.headroomPercent}%))`,
      ...report.warnings,
    ];
    if (report.package.largestFiles.length > 0) {
      lines.push(
        "Largest packed files (up to 10):",
        ...report.package.largestFiles.map((file) => `- ${file.path}: ${file.size} bytes`),
      );
    }
    if (!report.passed) {
      throw new Error(
        [
          "NPM unpacked size benchmark failed",
          ...lines,
          ...report.violations.map((violation) => `- ${violation}`),
        ].join("\n"),
      );
    }
    console.log(lines.join("\n"));

    return report;
  } finally {
    if (packFilename && fs.existsSync(packFilename)) {
      fs.unlinkSync(packFilename);
    }
    runCommand(["bun", "run", "postpublish"], true);
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const config = loadThresholdConfig(options.configPath);

  try {
    runBenchmark(config, options.outputPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
