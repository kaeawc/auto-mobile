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
  return `broker-scenario.ts list | run <name> [--dry-run] [--device] [--crash] [--max-devices <1..4>] [--batch-dir <path>]
Fake scenarios use an isolated in-memory SessionBroker with no devices or daemon.
Evidence: <MT_BATCH or --batch-dir>/evidence/<scenario>/summary.json.
Device scenarios require --device and an already-running private broker batch.
Device execution uses owned proxies; unavailable resource-state assertions are marked not-verifiable.
--device selects the device variant when a fake scenario has the same name.
--crash is restricted to daemon-restart-with-live-sessions; --max-devices defaults to 2 (hard maximum 4).`;
}
export type BrokerDeviceContextFactory = NonNullable<BrokerScenario["createContext"]>;
export async function runBrokerScenarioCli(
  argv: string[],
  env: Record<string, string | undefined>,
  log: (message: string) => void = console.log,
  deviceContext?: BrokerDeviceContextFactory,
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
  if (op !== "run" || !brokerScenarios.some((entry) => entry.name === name)) {
    log(brokerScenarioHelp());
    return 2;
  }
  const seen = new Set<string>();
  let batchDir = env.MT_BATCH;
  let maxDevices = 2;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (
      seen.has(flag) ||
      !["--dry-run", "--device", "--crash", "--max-devices", "--batch-dir"].includes(flag)
    ) {
      log(`Unknown or duplicate scenario flag: ${flag}`);
      return 2;
    }
    seen.add(flag);
    if (flag === "--batch-dir" || flag === "--max-devices") {
      const value = flags[++index];
      if (!value || value.startsWith("--")) {
        log(`${flag} needs a value.`);
        return 2;
      }
      if (flag === "--batch-dir") {
        batchDir = value;
      } else {
        maxDevices = Number(value);
      }
    }
  }
  const scenario =
    brokerScenarios.find(
      (entry) => entry.name === name && entry.class === (seen.has("--device") ? "device" : "fake"),
    ) ?? brokerScenarios.find((entry) => entry.name === name)!;
  if (!Number.isInteger(maxDevices) || maxDevices < 1 || maxDevices > 4) {
    log("--max-devices must be an integer from 1 to 4.");
    return 2;
  }
  if (
    seen.has("--crash") &&
    (scenario.class !== "device" || name !== "daemon-restart-with-live-sessions")
  ) {
    log("--crash requires daemon-restart-with-live-sessions --device.");
    return 2;
  }
  if (!batchDir) {
    log("Set MT_BATCH or --batch-dir for scenario evidence.");
    return 2;
  }
  if (scenario.class === "device" && !seen.has("--device")) {
    log("Device scenarios require --device.");
    return 2;
  }
  if (seen.has("--dry-run")) {
    log(
      JSON.stringify({
        name,
        class: scenario.class,
        batchDir: resolve(batchDir),
        dryRun: true,
        maxDevices,
        crash: seen.has("--crash"),
      }),
    );
    return 0;
  }
  return executeScenario(
    scenario,
    resolve(batchDir),
    {
      dryRun: seen.has("--dry-run"),
      device: seen.has("--device"),
      maxDevices,
      crash: seen.has("--crash"),
    },
    log,
    deviceContext,
  );
}
async function executeScenario(
  scenario: BrokerScenario,
  batchDir: string,
  options: { dryRun: boolean; device: boolean; maxDevices: number; crash: boolean },
  log: (message: string) => void,
  deviceContext?: BrokerDeviceContextFactory,
): Promise<number> {
  if (scenario.class === "device" && !options.device) {
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
      ? await (
          deviceContext ??
          scenario.createContext ??
          ((directory, fs) =>
            import("./brokerLiveAdapter").then((module) =>
              module.createBrokerLiveContext(directory, fs, { maxDevices: options.maxDevices }),
            ))
        )(batchDir, evidence)
      : await (
          await import("../../test/helpers/fakeBrokerScenarioContext")
        ).createFakeBrokerScenarioContext(scenario, batchDir, evidence);
  if (!harness) {
    log("Device scenario context is not installed.");
    return 2;
  }
  try {
    const context = harness.context;
    const capacity = context.deviceOps?.totalDeviceCap;
    const selected =
      scenario.class === "device" && capacity !== undefined
        ? {
            ...context,
            clients: context.clients.slice(
              0,
              scenario.name === "capacity-refusal-and-replay" ? capacity + 1 : capacity,
            ),
          }
        : context;
    const summary = await runBrokerScenario(scenario, selected, options);
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
