#!/usr/bin/env bun
import "./harnessLogSink";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { errorMessage } from "../../src/utils/describeUnknownError";
import {
  brokerScenarios,
  runBrokerScenario,
  type BrokerScenario,
  type BrokerScenarioContext,
} from "./brokerScenarios";

export function brokerScenarioHelp(): string {
  return `broker-scenario.ts list | run <name> [--dry-run] [--device] [--batch-dir <path>]
Fake scenarios use an isolated in-memory SessionBroker with no devices or daemon.
Evidence: <MT_BATCH or --batch-dir>/evidence/<scenario>/summary.json.
Device scenarios require --device and an already-running private broker batch.
Device scenarios are registered separately; none are registered in this step.`;
}
export async function runBrokerScenarioCli(
  argv: string[],
  env: Record<string, string | undefined>,
  log: (message: string) => void = console.log,
): Promise<number> {
  if (argv.length === 1 && ["--help", "-h", "help"].includes(argv[0])) {
    log(brokerScenarioHelp());
    return 0;
  }
  if (argv.length === 1 && argv[0] === "list") {
    log(brokerScenarios.map((s) => `${s.name}\t${s.class}`).join("\n"));
    return 0;
  }
  const [op, name, ...flags] = argv;
  const scenario = brokerScenarios.find((entry) => entry.name === name);
  if (op !== "run" || !scenario) {
    log(brokerScenarioHelp());
    return 2;
  }
  const seen = new Set<string>();
  let batchDir = env.MT_BATCH;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (seen.has(flag) || !["--dry-run", "--device", "--batch-dir"].includes(flag)) {
      log(`Unknown or duplicate scenario flag: ${flag}`);
      return 2;
    }
    seen.add(flag);
    if (flag === "--batch-dir") {
      const value = flags[++index];
      if (!value || value.startsWith("--")) {
        log("--batch-dir needs a path.");
        return 2;
      }
      batchDir = value;
    }
  }
  if (!batchDir) {
    log("Set MT_BATCH or --batch-dir for scenario evidence.");
    return 2;
  }
  return runFakeScenario(
    scenario,
    resolve(batchDir),
    seen.has("--dry-run"),
    seen.has("--device"),
    log,
  );
}
async function runFakeScenario(
  scenario: BrokerScenario,
  batchDir: string,
  dryRun: boolean,
  device: boolean,
  log: (message: string) => void,
): Promise<number> {
  if (scenario.class === "device" && !device) {
    log("Device scenarios require --device.");
    return 2;
  }
  const evidence: BrokerScenarioContext["fs"] = {
    mkdir: (path) => {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    },
    writeFile: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
  };
  const harness =
    scenario.class === "device"
      ? await scenario.createContext?.(batchDir, evidence)
      : await (
          await import("../../test/helpers/fakeBrokerScenarioContext")
        ).createFakeBrokerScenarioContext(scenario, batchDir, evidence);
  if (!harness) {
    log("Device scenario context is not installed.");
    return 2;
  }
  try {
    const summary = await runBrokerScenario(scenario, harness.context, { dryRun, device });
    log(JSON.stringify(summary, null, 2));
    return summary.outcome === "failed" ? 1 : 0;
  } finally {
    await harness.close();
  }
}
if (import.meta.main) {
  try {
    process.exitCode = await runBrokerScenarioCli(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`broker-scenario: ${errorMessage(error)}`);
    process.exitCode = 2;
  }
}
