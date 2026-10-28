#!/usr/bin/env bun
/**
 * Persona robustness harness (#14061, research prototype): replay one test plan under the stock
 * baseline and a matrix of OEM manufacturer profiles and display stressors, score each replay as
 * pass / recovered / failed, and attribute failures to the perturbation that caused them.
 *
 * Usage:
 *   bun run build
 *   bun scripts/persona-robustness/run.ts --plan <plan.yaml> [options]
 *
 * Options:
 *   --app-id <pkg>        package the kill facet targets (default: the plan's first launchApp appId)
 *   --personas <a,b>      manufacturer profile ids and display:<stressor> ids (default: all)
 *   --repeats <n>         replays per perturbation, to separate flakiness from breakage (default 1)
 *   --ablate              re-run each failing persona one facet at a time
 *   --session <uuid>      reuse a held device session instead of calling getAndroid
 *   --avd <name>          avdName passed to getAndroid
 *   --server <path>       MCP server entry (default: this checkout's dist/src/index.js)
 *   --out <dir>           report directory (default: scratch/persona-robustness/<timestamp>)
 *
 * Writes report.json and report.md, and exits 0 when the harness completed (whatever the
 * verdicts), 1 when it aborted, 2 on a usage error.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { importPlanFromYaml } from "../../src/utils/planUtils";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { createSdkClient, defaultServerPath, resolveTimeoutMs } from "../mcp-drive";
import { BASELINE_PERSONA_ID, personaPerturbation, selectPerturbations } from "./matrix";
import { runHarness, type HarnessOptions } from "./harness";
import { renderMarkdown } from "./report";

export interface CliOptions {
  harness: HarnessOptions;
  serverPath?: string;
  outDir: string;
}

/** The first `launchApp` step's appId, the package a kill facet should target. */
export function planAppId(plan: ReturnType<typeof importPlanFromYaml>): string | undefined {
  const step = plan.steps.find(
    (candidate) => candidate.tool === "launchApp" && typeof candidate.params.appId === "string",
  );
  const appId: unknown = step?.params.appId;
  return typeof appId === "string" ? appId : undefined;
}

export function parseCli(
  argv: string[],
  readFile: (path: string) => string,
  now: Date,
): CliOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      plan: { type: "string" },
      "app-id": { type: "string" },
      personas: { type: "string" },
      repeats: { type: "string" },
      ablate: { type: "boolean" },
      session: { type: "string" },
      avd: { type: "string" },
      server: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.plan) {
    throw new Error("--plan <plan.yaml> is required.");
  }
  const planContent = readFile(values.plan);
  const plan = importPlanFromYaml(planContent);
  const appId = values["app-id"] ?? planAppId(plan);
  if (!appId) {
    throw new Error("The plan has no launchApp appId; pass --app-id <package>.");
  }
  const repeats = values.repeats === undefined ? 1 : Number(values.repeats);
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new Error(`--repeats must be a positive integer (got "${values.repeats}").`);
  }
  const selection = (values.personas ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const stamp = now
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/, "Z");
  return {
    harness: {
      planName: plan.name,
      planContent,
      appId,
      baseline: personaPerturbation(BASELINE_PERSONA_ID, appId),
      perturbations: selectPerturbations(selection, appId),
      repeats,
      ablate: values.ablate ?? false,
      ...(values.session ? { session: values.session } : {}),
      ...(values.avd ? { acquireArgs: { avdName: values.avd } } : {}),
    },
    ...(values.server ? { serverPath: resolve(values.server) } : {}),
    outDir: resolve(values.out ?? join("scratch", "persona-robustness", stamp)),
  };
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCli(process.argv.slice(2), (path) => readFileSync(path, "utf8"), new Date());
  } catch (error) {
    console.error(`persona-robustness: ${errorMessage(error)}`);
    process.exit(2);
  }
  const client = await createSdkClient(
    options.serverPath ?? defaultServerPath(),
    resolveTimeoutMs(undefined, process.env),
  );
  try {
    const report = await runHarness(options.harness, {
      client,
      log: (message) => console.log(message),
      now: () => Date.now(),
    });
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(join(options.outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(options.outDir, "report.md"), renderMarkdown(report));
    console.log(`report: ${join(options.outDir, "report.md")}`);
    process.exitCode = report.aborted ? 1 : 0;
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  void main();
}
