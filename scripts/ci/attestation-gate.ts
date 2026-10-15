import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { logger } from "../../src/utils/logger";
import { runAttestationGate, sanitizeAttestationOutput } from "./attestationGate/gate";
import {
  failClosedValidators,
  gitTreeInputHasher,
  jsonlFileRecorder,
  unconfiguredTransport,
} from "./attestationGate/defaults";

export function resolveCliOptions(
  argv: string[],
  env: Readonly<Record<string, string | undefined>>,
) {
  const { values } = parseArgs({
    args: argv,
    options: { tier: { type: "string", default: "1" }, record: { type: "string" } },
    strict: true,
  });
  const tier = Number(values.tier);
  if (tier !== 1 && tier !== 2 && tier !== 3) {
    throw new Error("tier must be 1, 2 or 3");
  }
  return {
    tier,
    record: values.record ?? join(env.RUNNER_TEMP ?? ".", "attestation-shadow.jsonl"),
    repo: env.GITHUB_REPOSITORY ?? "",
    commitSha: env.ATTESTATION_COMMIT_SHA ?? env.GITHUB_SHA ?? "",
  };
}

export async function main(argv: string[]): Promise<void> {
  try {
    const { tier, record, repo, commitSha } = resolveCliOptions(argv, process.env);
    const entry = await runAttestationGate({
      transport: unconfiguredTransport,
      hasher: gitTreeInputHasher(),
      validators: failClosedValidators,
      recorder: jsonlFileRecorder(record),
      clock: { now: () => new Date(defaultTimer.now()) },
      repo,
      commitSha,
      repoRoot: process.cwd(),
      tier,
      mode: "shadow",
    });
    console.log(
      sanitizeAttestationOutput(
        `attestation-gate[shadow] tier=${tier} decision=${entry.decision} wouldApply=${entry.wouldApply} applied=${entry.applied} reasons=${entry.reasons.join("; ")}`,
      ),
    );
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `| Tier | Decision | Would apply | Applied |\n| --- | --- | --- | --- |\n${sanitizeAttestationOutput(`| ${tier} | ${entry.decision} | ${entry.wouldApply} | ${entry.applied} |`)}\n`,
      );
    }
  } catch (error) {
    logger.warn("Attestation shadow CLI failed; continuing CI", error);
  }
}
if (import.meta.main) {
  await main(process.argv.slice(2));
  process.exitCode = 0;
}
