#!/usr/bin/env bun
/** Usage: bun run qualify:run-case --case-id <id> --title <title> --platform <platform> --proof-level <level> --observation <kind> --out <file> -- <command...> */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { UsageError, type ArtifactIdentityRecord } from "./artifactIdentity";
import { parseCaseResult, type CaseResult } from "./caseResult";

export interface RunCasePorts {
  now(): number;
  spawn(argv: readonly string[], cwd: string): Promise<{ exitCode: number }>;
  readText(path: string): string;
  writeText(path: string, text: string): void;
  sha256File(path: string): string | null;
  repoRoot: string;
}
export interface RunCaseOptions {
  caseId: string;
  title: string;
  platform: CaseResult["platform"];
  proofLevel: CaseResult["proofLevel"];
  observation: CaseResult["observation"];
  matrixItem: number | null;
  evidence: Array<Pick<CaseResult["evidence"][number], "path" | "kind">>;
  fixtures: CaseResult["fixtures"];
  failureCode: string | null;
  boundary: string | null;
  notes: string | null;
  identity?: string;
  notExercised: boolean;
  out: string;
  argv: string[];
  cwd: string;
}

function validate(value: unknown): CaseResult {
  try {
    return parseCaseResult(value);
  } catch (error) {
    throw new UsageError(
      `Invalid case result: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseRunCaseArgs(argv: readonly string[]): RunCaseOptions {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    throw new UsageError("-- <command...> is required");
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv.slice(0, separator)],
      allowPositionals: false,
      options: {
        "case-id": { type: "string" },
        title: { type: "string" },
        platform: { type: "string" },
        "proof-level": { type: "string" },
        observation: { type: "string" },
        "fault-mechanism": { type: "string" },
        fault: { type: "string" },
        "matrix-item": { type: "string" },
        identity: { type: "string" },
        evidence: { type: "string", multiple: true },
        fixture: { type: "string", multiple: true },
        "failure-code": { type: "string" },
        boundary: { type: "string" },
        notes: { type: "string" },
        "not-exercised": { type: "boolean" },
        out: { type: "string" },
      },
    }));
  } catch (error) {
    throw new UsageError(
      `Invalid run-case arguments: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!values.out) {
    throw new UsageError("--out is required");
  }
  const injected = values.observation === "injected-fault";
  if (
    injected
      ? !values["fault-mechanism"] || !values.fault
      : values["fault-mechanism"] !== undefined || values.fault !== undefined
  ) {
    throw new UsageError(
      "--fault-mechanism and --fault are required iff --observation injected-fault",
    );
  }
  const record = validate({
    schemaVersion: 1,
    caseId: values["case-id"],
    title: values.title,
    platform: values.platform,
    proofLevel: values["proof-level"],
    matrixItem: values["matrix-item"] === undefined ? null : Number(values["matrix-item"]),
    artifact: { packageVersion: null, sourceSha: null, integrity: null },
    command: { argv: argv.slice(separator + 1), cwd: "." },
    outcome: values["not-exercised"] ? "not-exercised" : "pass",
    observation: injected
      ? { kind: values.observation, mechanism: values["fault-mechanism"], fault: values.fault }
      : { kind: values.observation },
    timings: {
      startedAt: "1970-01-01T00:00:00.000Z",
      finishedAt: "1970-01-01T00:00:00.000Z",
      durationMs: 0,
      operations: [],
    },
    evidence: (values.evidence ?? []).map((entry) => {
      const colon = entry.lastIndexOf(":");
      if (colon < 1) {
        throw new UsageError("--evidence must be <path>:<kind>");
      }
      return { path: entry.slice(0, colon), kind: entry.slice(colon + 1), sha256: null };
    }),
    fixtures: (values.fixture ?? []).map((entry) => {
      const equals = entry.indexOf("=");
      if (equals < 1) {
        throw new UsageError("--fixture must be <role>=<fixture-id>");
      }
      return { role: entry.slice(0, equals), id: entry.slice(equals + 1) };
    }),
    failureCode: values["failure-code"] ?? null,
    boundary: values.boundary ?? null,
    notes: values.notes ?? null,
  });
  return {
    ...record,
    evidence: record.evidence,
    argv: record.command.argv,
    cwd: process.cwd(),
    identity: values.identity,
    notExercised: values["not-exercised"] ?? false,
    out: values.out,
  };
}

export async function runCase(
  options: RunCaseOptions,
  ports: RunCasePorts,
): Promise<{ result: CaseResult; exitCode: number }> {
  let artifact: CaseResult["artifact"] = { packageVersion: null, sourceSha: null, integrity: null };
  if (options.identity) {
    const identity = JSON.parse(ports.readText(options.identity)) as ArtifactIdentityRecord;
    if (identity.verdict !== "identified") {
      throw new UsageError("Artifact identity is refused");
    }
    if (options.proofLevel === "published-package" && identity.proofLevel !== "published-package") {
      throw new UsageError("Published-package cases require a published-package identity");
    }
    artifact = {
      packageVersion: identity.package.version,
      sourceSha: identity.source.sha,
      integrity: identity.tarball?.integrity ?? null,
    };
  }
  const started = ports.now();
  const draft = validate({
    schemaVersion: 1,
    caseId: options.caseId,
    title: options.title,
    matrixItem: options.matrixItem,
    platform: options.platform,
    proofLevel: options.proofLevel,
    artifact,
    command: {
      argv: options.argv,
      cwd: relative(ports.repoRoot, options.cwd).split(sep).join("/") || ".",
    },
    outcome: options.notExercised ? "not-exercised" : "pass",
    observation: options.observation,
    timings: {
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(started).toISOString(),
      durationMs: 0,
      operations: [],
    },
    evidence: options.evidence.map((entry) => ({ ...entry, sha256: null })),
    fixtures: options.fixtures,
    failureCode: options.failureCode,
    boundary: options.boundary,
    notes: options.notes,
  });
  const exitCode = options.notExercised
    ? 0
    : (await ports.spawn(options.argv, options.cwd)).exitCode;
  const finished = options.notExercised ? started : ports.now();
  const durationMs = finished - started;
  const result = validate({
    ...draft,
    outcome: options.notExercised ? "not-exercised" : exitCode === 0 ? "pass" : "fail",
    timings: {
      ...draft.timings,
      finishedAt: new Date(finished).toISOString(),
      durationMs,
      operations: options.notExercised ? [] : [{ name: "command", durationMs, budgetMs: null }],
    },
    evidence: draft.evidence.map((entry) => ({
      ...entry,
      sha256: ports.sha256File(resolve(ports.repoRoot, entry.path)),
    })),
  });
  ports.writeText(options.out, `${JSON.stringify(result, null, 2)}\n`);
  return { result, exitCode };
}

if (import.meta.main) {
  try {
    const { exitCode } = await runCase(parseRunCaseArgs(process.argv.slice(2)), {
      now: Date.now,
      spawn: async (argv, cwd) => ({
        exitCode: await Bun.spawn([...argv], {
          cwd,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }).exited,
      }),
      readText: (path) => readFileSync(path, "utf8"),
      writeText: writeFileSync,
      sha256File: (path) =>
        existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null,
      repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    });
    process.exitCode = exitCode;
  } catch (error) {
    console.error("Run case failed:", error);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
