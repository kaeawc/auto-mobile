#!/usr/bin/env bun
/** Usage: bun scripts/qualification/caseResult.ts --write | --check */
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { z } from "zod/v4";
import { UsageError } from "./artifactIdentity";

const nonEmpty = z.string().min(1);
// POSIX only, with no parent segment or home expansion, including embedded ~.
const relativePath = nonEmpty.regex(/^(?!\/)(?!.*\\)(?!.*~)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/);
const duration = z.number().int().nonnegative();
// CLI metadata is validated before an identity is read; it is not yet artifact-bound evidence.
export const caseMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    caseId: z
      .string()
      .max(96)
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/),
    title: nonEmpty,
    matrixItem: z.number().int().min(1).max(10).nullable(),
    platform: z.enum(["android", "ios", "host"]),
    proofLevel: z.enum(["source-tests", "local-build", "published-package"]),
    artifact: z
      .object({
        packageVersion: z.string().nullable(),
        sourceSha: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .nullable(),
        integrity: z
          .string()
          .regex(/^sha512-/)
          .nullable(),
      })
      .strict()
      .describe(
        "local-build and published-package require non-null packageVersion and sourceSha; published-package also requires non-null integrity.",
      ),
    command: z.object({ argv: z.array(nonEmpty).min(1), cwd: relativePath }).strict(),
    outcome: z.enum(["pass", "fail", "blocked", "not-exercised"]),
    observation: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("native") }).strict(),
        z
          .object({ kind: z.literal("injected-fault"), mechanism: nonEmpty, fault: nonEmpty })
          .strict(),
        z.object({ kind: z.literal("deterministic-test") }).strict(),
      ])
      .describe("Native observation is invalid at the source-tests proof level."),
    timings: z
      .object({
        startedAt: z.iso.datetime({ offset: true }),
        finishedAt: z.iso
          .datetime({ offset: true })
          .describe("finishedAt must be at or after startedAt."),
        durationMs: duration,
        operations: z
          .array(
            z
              .object({
                name: nonEmpty,
                durationMs: duration,
                budgetMs: z.number().int().positive().nullable(),
              })
              .strict(),
          )
          .describe(
            "Operation durationMs may exceed budgetMs; the aggregator flags this evidence.",
          ),
      })
      .strict(),
    evidence: z.array(
      z
        .object({
          path: relativePath,
          kind: z.enum(["log", "json", "screenshot", "video", "db-snapshot", "other"]),
          sha256: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .nullable(),
        })
        .strict(),
    ),
    fixtures: z.array(
      z.object({ role: nonEmpty, id: z.string().regex(/^fixture-[a-z0-9-]{1,48}$/) }).strict(),
    ),
    failureCode: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .nullable(),
    boundary: z
      .string()
      .nullable()
      .describe("boundary must be non-empty for blocked or not-exercised outcomes."),
    notes: z.string().nullable(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (["blocked", "not-exercised"].includes(result.outcome) && !result.boundary?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["boundary"],
        message: "A supported boundary is required for blocked or not-exercised cases",
      });
    }
    if (result.observation.kind === "native" && result.proofLevel === "source-tests") {
      ctx.addIssue({
        code: "custom",
        path: ["observation", "kind"],
        message: "Source tests cannot be native observations",
      });
    }
    if (Date.parse(result.timings.finishedAt) < Date.parse(result.timings.startedAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["timings", "finishedAt"],
        message: "finishedAt must be at or after startedAt",
      });
    }
  });

export const caseResultSchema = caseMetadataSchema.superRefine((result, ctx) => {
  const required =
    result.proofLevel === "published-package"
      ? (["packageVersion", "sourceSha", "integrity"] as const)
      : result.proofLevel === "local-build"
        ? (["packageVersion", "sourceSha"] as const)
        : [];
  for (const field of required) {
    if (result.artifact[field] === null) {
      ctx.addIssue({
        code: "custom",
        path: ["artifact", field],
        message: `${result.proofLevel} requires non-null artifact.${field}`,
      });
    }
  }
});

export type CaseResult = z.infer<typeof caseResultSchema>;
export function parseCaseResult(value: unknown): CaseResult {
  return caseResultSchema.parse(value);
}
export function caseResultJsonSchema() {
  return z.toJSONSchema(caseResultSchema);
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { write: { type: "boolean" }, check: { type: "boolean" } },
      allowPositionals: false,
    });
    if (Boolean(values.write) === Boolean(values.check)) {
      throw new UsageError("Choose exactly one of --write or --check");
    }
    const path = new URL("./case-result.schema.json", import.meta.url);
    const text = `${JSON.stringify(caseResultJsonSchema(), null, 2)}\n`;
    if (values.write) {
      writeFileSync(path, text);
    } else if (!isDeepStrictEqual(JSON.parse(readFileSync(path, "utf8")), caseResultJsonSchema())) {
      console.error("Case-result JSON Schema drift; run with --write");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("Case-result schema failed:", error);
    process.exitCode =
      error instanceof UsageError ||
      (error instanceof TypeError &&
        "code" in error &&
        String(error.code).startsWith("ERR_PARSE_ARGS"))
        ? 2
        : 1;
  }
}
