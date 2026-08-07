#!/usr/bin/env bun

/**
 * Deploy-continuity gate for managed iOS simulators (issue #5104).
 *
 * Reads the before/after evidence captured around a worker/AutoMobile rollout
 * (see docs/release/ios-simulator-continuity.md for the capture commands),
 * classifies what happened to the simulator, prints a redacted summary safe to
 * retain with the deployment record, and exits non-zero unless continuity is
 * proven — so a rollout that cannot prove continuity fails the deploy loudly.
 *
 * Usage:
 *   bun scripts/validate-ios-simulator-continuity.ts \
 *     --before before.json --after after.json --deploy deploy.json [--out redacted.json]
 *
 * before.json / after.json are ContinuitySnapshot records; deploy.json is a
 * DeploymentWindow. --deploy is required: reboot detection is only meaningful
 * against a real deploy window, so there is no sound default for it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  classifyContinuity,
  continuityExitCode,
  redactContinuityEvidence,
  type ContinuitySnapshot,
  type DeploymentWindow,
  type SimulatorLifecycleState,
  type ReportingStatus,
} from "../src/utils/iosSimulatorContinuity";

interface Args {
  readonly before?: string;
  readonly after?: string;
  readonly deploy?: string;
  readonly out?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag.startsWith("--")) {
      const key = flag.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        args[key] = value;
        i++;
      }
    }
  }
  return { before: args.before, after: args.after, deploy: args.deploy, out: args.out };
}

function asRecord(value: unknown, source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function str(rec: Record<string, unknown>, key: string): string {
  const value = rec[key];
  return typeof value === "string" ? value : "";
}

function optionalStr(rec: Record<string, unknown>, key: string): string | undefined {
  const value = rec[key];
  return typeof value === "string" ? value : undefined;
}

function bool(rec: Record<string, unknown>, key: string): boolean {
  return rec[key] === true;
}

const LIFECYCLE_STATES: ReadonlySet<string> = new Set([
  "booted",
  "shutdown",
  "booting",
  "shutting-down",
  "unknown",
]);
const REPORTING_STATES: ReadonlySet<string> = new Set(["reporting", "delayed", "lost", "unknown"]);

function lifecycle(rec: Record<string, unknown>): SimulatorLifecycleState {
  const value = str(rec, "lifecycleState");
  return LIFECYCLE_STATES.has(value) ? (value as SimulatorLifecycleState) : "unknown";
}

function reporting(rec: Record<string, unknown>): ReportingStatus {
  const value = str(rec, "reportingStatus");
  return REPORTING_STATES.has(value) ? (value as ReportingStatus) : "unknown";
}

function processIds(rec: Record<string, unknown>): Record<string, number> {
  const raw = rec.processIds;
  const out: Record<string, number> = {};
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [name, pid] of Object.entries(raw)) {
      if (typeof pid === "number" && Number.isFinite(pid)) {
        out[name] = pid;
      }
    }
  }
  return out;
}

function parseSnapshot(raw: unknown, source: string): ContinuitySnapshot {
  const rec = asRecord(raw, source);
  return {
    udid: str(rec, "udid"),
    runtimeDeviceType: str(rec, "runtimeDeviceType"),
    hostIdentity: str(rec, "hostIdentity"),
    automobileVersion: str(rec, "automobileVersion"),
    workerIncarnation: str(rec, "workerIncarnation"),
    processSupervisor: str(rec, "processSupervisor"),
    processIds: processIds(rec),
    coreSimulatorDataRoot: str(rec, "coreSimulatorDataRoot"),
    bootedSince: optionalStr(rec, "bootedSince"),
    lifecycleState: lifecycle(rec),
    responsive: bool(rec, "responsive"),
    reportingStatus: reporting(rec),
    activeWork: bool(rec, "activeWork"),
  };
}

function parseDeploy(raw: unknown, source: string): DeploymentWindow {
  const rec = asRecord(raw, source);
  return {
    startedAt: str(rec, "startedAt"),
    completedAt: str(rec, "completedAt"),
    plannedReplacement: bool(rec, "plannedReplacement"),
  };
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

const USAGE =
  "Usage: bun scripts/validate-ios-simulator-continuity.ts --before <file> --after <file> --deploy <file> [--out <file>]";

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (!args.before || !args.after || !args.deploy) {
    console.error(USAGE);
    return 2;
  }

  let before: ContinuitySnapshot;
  let after: ContinuitySnapshot;
  let deploy: DeploymentWindow;
  try {
    before = parseSnapshot(readJson(args.before), args.before);
    after = parseSnapshot(readJson(args.after), args.after);
    deploy = parseDeploy(readJson(args.deploy), args.deploy);
  } catch (error) {
    // Bad input (missing file / malformed JSON) is a usage error (exit 2), kept
    // distinct from a well-formed "continuity not proven" result (exit 1).
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }

  const result = classifyContinuity(before, after, deploy);
  const redacted = redactContinuityEvidence({ before, after, deploy, result });
  const serialized = JSON.stringify(redacted, null, 2);

  console.log(serialized);
  console.log(`\nverdict: ${result.verdict}`);
  console.log(`proven: ${result.proven}`);
  console.log(`recommended state: ${result.recommendedState}`);
  for (const reason of result.reasons) {
    console.log(`  - ${reason}`);
  }

  if (args.out) {
    writeFileSync(args.out, serialized);
    console.log(`\nredacted evidence written to ${args.out}`);
  }

  return continuityExitCode(result);
}

process.exit(main());
