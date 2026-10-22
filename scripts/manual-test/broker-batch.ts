#!/usr/bin/env bun
import "./harnessLogSink";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseSessionBrokerHostConfig } from "../../src/daemon/sessionBroker/hostConfig";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { MAX_SETTIMEOUT_DELAY_MS, type Timer } from "../../src/utils/SystemTimer";
import { raceWithDeadline } from "../../src/utils/raceWithDeadline";
import { parseBrokerBatch, planExpectations } from "./brokerBatch";
import { brokerBatchHelp } from "./brokerBatchHelp";
import { readBrokerClients, resolveBrokerClient } from "./brokerClientFiles";
import {
  BROKER_CLEANUP_TIMEOUT_MS,
  createFrameBrokerDaemonClient,
  type BrokerDaemonClient,
} from "./brokerDaemonClient";
import {
  assertReleasedAndAbsent,
  BrokerDeviceLedger,
  BrokerDeviceInfoRefusedError,
  type BrokerLedgerFs,
  type LedgerDevicesView,
} from "./brokerDeviceLedger";
import { probeControlSocket, type ControlSocketProbeResult } from "./controlSocketProbe";
import { connectFrameSocket } from "./daemon-frame";
import { createPrivateDaemonDeps, runPrivateDaemonCommand } from "./private-daemon";
import {
  createProxySessionDeps,
  parseProxySessionArgs,
  runProxySessionCommand,
} from "./proxy-session";
import { brokerSocketPath } from "./proxySessionLifecycle";
import { definedEnv } from "./privateDaemonStatus";

const ACQUIRE_TIMEOUT_MS = 26 * 60_000;
const expectedSchema = z.enum(["ready", "failed:capacity_exhausted"]);
const launchSchema = z.object({
  client: z.string(),
  expected: expectedSchema,
  startedAt: z.number(),
  durationMs: z.number().optional(),
  exitCode: z.number().optional(),
});
const stateSchema = z.object({ launches: z.array(launchSchema) });
type Launch = z.infer<typeof launchSchema>;
const sessionSchema = z.object({
  requestId: z.string(),
  outcome: z.enum(["ready", "pending", "released", "failed"]),
  sessionUuid: z.string().nullable(),
  cleanupPending: z.boolean(),
  failure: z.object({ code: z.string(), retryable: z.boolean() }).optional(),
});
export interface BrokerBatchCommand {
  op: "up" | "status" | "down" | "report";
  clients?: string[];
  staggerMs: number;
  maxDevices: number;
}
export interface BrokerBatchOrchestratorDeps {
  batchDir: string;
  fs: BrokerLedgerFs & { writeFile(path: string, text: string): void };
  timer: Timer;
  daemonClient: BrokerDaemonClient;
  preflight(): Promise<number>;
  probe(options: { requireCapability: string }): Promise<ControlSocketProbeResult>;
  /** argv starts at private-daemon boot-gate, and includes the complete proxy command. */
  spawnClient(argv: string[]): Promise<number>;
  proxy(argv: string[]): Promise<number>;
  devicesView(): Promise<LedgerDevicesView>;
  isPidAlive(pid: number): boolean;
  log(text: string): void;
  acquisitionTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}
export function parseBrokerBatchArgs(
  argv: string[],
): BrokerBatchCommand | { help: string } | { error: string } {
  if (argv.some((arg) => ["help", "--help", "-h"].includes(arg))) {
    return { help: brokerBatchHelp() };
  }
  const [op, ...args] = argv;
  if (!["up", "status", "down", "report"].includes(op)) {
    return { error: brokerBatchHelp() };
  }
  const values = new Map<string, string>();
  let all = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (op !== "up") {
      return { error: `${op} does not accept flags.` };
    }
    if (flag === "--all" && !all) {
      all = true;
    } else if (
      ["--clients", "--stagger-ms", "--max-devices"].includes(flag) &&
      !values.has(flag) &&
      args[index + 1] !== undefined
    ) {
      values.set(flag, args[++index]);
    } else {
      return { error: `Unknown, duplicate or incomplete flag: ${flag}` };
    }
  }
  const rawClients = values.get("--clients");
  const clients = rawClients?.split(",");
  if (
    clients &&
    (all ||
      new Set(clients).size !== clients.length ||
      clients.some((name) => !/^[a-z0-9-]{1,32}$/.test(name)))
  ) {
    return { error: "--clients requires unique client names and excludes --all." };
  }
  const staggerMs = Number(values.get("--stagger-ms") ?? 0);
  const maxDevices = Number(values.get("--max-devices") ?? 2);
  if (!Number.isSafeInteger(staggerMs) || staggerMs < 0 || staggerMs > MAX_SETTIMEOUT_DELAY_MS) {
    return { error: "--stagger-ms must be a nonnegative timer-safe integer." };
  }
  if (!Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 4) {
    return { error: "--max-devices must be an integer from 1 to the hard ceiling of 4." };
  }
  return { op: op as BrokerBatchCommand["op"], clients, staggerMs, maxDevices };
}
function statePath(deps: BrokerBatchOrchestratorDeps): string {
  return join(deps.batchDir, "evidence/broker-launches.json");
}
function readState(deps: BrokerBatchOrchestratorDeps): { launches: Launch[] } {
  return deps.fs.exists(statePath(deps))
    ? stateSchema.parse(JSON.parse(deps.fs.readFile(statePath(deps))))
    : { launches: [] };
}
function writeEvidence(name: string, data: unknown, deps: BrokerBatchOrchestratorDeps): void {
  deps.fs.mkdir(join(deps.batchDir, "evidence"));
  deps.fs.writeFile(join(deps.batchDir, "evidence", name), `${JSON.stringify(data, null, 2)}\n`);
}
function readSession(name: string, deps: BrokerBatchOrchestratorDeps) {
  const path = join(deps.batchDir, "sessions", name, "init.json");
  return deps.fs.exists(path)
    ? z.object({ session: sessionSchema }).parse(JSON.parse(deps.fs.readFile(path))).session
    : undefined;
}
function ledgerFor(deps: BrokerBatchOrchestratorDeps): BrokerDeviceLedger {
  return new BrokerDeviceLedger({
    batchDir: deps.batchDir,
    fs: deps.fs,
    timer: deps.timer,
    tokenFor: (name) => deps.fs.readFile(join(deps.batchDir, "sessions", name, "owner-token")),
  });
}
function expectationPlan(command: BrokerBatchCommand, deps: BrokerBatchOrchestratorDeps) {
  const host = parseSessionBrokerHostConfig(
    JSON.parse(deps.fs.readFile(join(deps.batchDir, "broker/host-config.json"))),
  );
  const names = command.clients ?? readBrokerClients(deps.batchDir, deps.fs);
  const clients = names.map((name) => {
    const { initial } = resolveBrokerClient(deps.batchDir, name, deps.fs);
    return {
      name,
      platform: initial.device.platform,
      hardware: initial.device.hardware,
      os: initial.device.os,
    };
  });
  const manifest = deps.fs.exists(join(deps.batchDir, "batch.json"))
    ? z
        .object({ broker: z.object({ allowReuse: z.boolean().optional() }).optional() })
        .parse(JSON.parse(deps.fs.readFile(join(deps.batchDir, "batch.json"))))
    : undefined;
  const batch = parseBrokerBatch(
    {
      schemaVersion: 1,
      limits: host.limits,
      defaults: host.defaults,
      reuseCleanDevices: host.reuseCleanDevices,
      reuse: host.reuse,
      clients,
    },
    { maxDevices: command.maxDevices, allowReuse: manifest?.broker?.allowReuse ?? false },
  );
  return { plan: planExpectations(batch), permits: Math.max(1, batch.limits.totalDeviceCap) };
}
async function runUp(
  command: BrokerBatchCommand,
  deps: BrokerBatchOrchestratorDeps,
): Promise<number> {
  const { plan, permits } = expectationPlan(command, deps);
  for (const name of readBrokerClients(deps.batchDir, deps.fs)) {
    const path = join(deps.batchDir, "sessions", name, "driver.pid");
    if (deps.fs.exists(path) && deps.isPidAlive(Number(deps.fs.readFile(path)))) {
      throw new Error("A batch client driver is still alive; run down before up.");
    }
  }
  if (
    (await raceWithDeadline(() => deps.preflight(), {
      timer: deps.timer,
      timeoutMs: 30_000,
      label: "Strict host preflight",
    })) !== 0
  ) {
    throw new Error("private-daemon preflight --strict must pass before broker-batch up.");
  }
  const probe = await raceWithDeadline(
    () => deps.probe({ requireCapability: "session-broker/v1" }),
    { timer: deps.timer, timeoutMs: 5000, label: "Broker capability probe" },
  );
  if (!probe.alive) {
    throw new Error(`Broker daemon is unavailable: ${probe.reason}`);
  }
  const state = readState(deps);
  let lastStart: number | undefined;
  const launch = async (item: (typeof plan)[number]): Promise<boolean> => {
    const row: Launch = { client: item.name, expected: item.expected, startedAt: deps.timer.now() };
    state.launches.push(row);
    writeEvidence("broker-launches.json", state, deps);
    try {
      row.exitCode = await raceWithDeadline(
        () =>
          deps.spawnClient([
            "boot-gate",
            "--batch-dir",
            deps.batchDir,
            "--role",
            item.name,
            "--max-concurrent",
            String(permits),
            "--",
            "bash",
            join(deps.batchDir, "bin/proxy1"),
            "up",
            "--client",
            item.name,
            "--expect",
            item.expected,
          ]),
        {
          timer: deps.timer,
          timeoutMs: deps.acquisitionTimeoutMs ?? ACQUIRE_TIMEOUT_MS,
          label: `Acquisition ${item.name}`,
        },
      );
      row.durationMs = deps.timer.now() - row.startedAt;
      const session = readSession(item.name, deps);
      const actual =
        session?.outcome === "failed" ? `failed:${session.failure?.code}` : session?.outcome;
      if (session?.outcome === "ready" && session.sessionUuid) {
        // Reopen after proxy up appended its grant; never replace the append-only ledger.
        const ledger = ledgerFor(deps);
        ledger.acquired(item.name, { session });
        const info = await raceWithDeadline(() => deps.daemonClient.info(session.sessionUuid!), {
          timer: deps.timer,
          timeoutMs: 5000,
          label: `Device info ${item.name}`,
        });
        try {
          ledger.info(item.name, { session }, info);
        } catch (error) {
          if (error instanceof BrokerDeviceInfoRefusedError) {
            ledger.record("leaked", {
              ...ledger.acquired(item.name, { session }),
              device: error.device,
            });
          }
          throw error;
        }
      }
      return row.exitCode === 0 && actual === item.expected;
    } catch (error) {
      deps.log(`Client ${item.name}: ${errorMessage(error)}`);
      row.exitCode = 2;
      return false;
    } finally {
      row.durationMs ??= deps.timer.now() - row.startedAt;
      writeEvidence("broker-launches.json", state, deps);
    }
  };
  const phase = async (expected: Launch["expected"]): Promise<boolean> => {
    const pending: Promise<boolean>[] = [];
    for (const item of plan.filter((entry) => entry.expected === expected)) {
      if (lastStart !== undefined) {
        const delay = Math.max(0, command.staggerMs - (deps.timer.now() - lastStart));
        if (delay > 0) {
          await deps.timer.sleep(delay);
        }
      }
      lastStart = deps.timer.now();
      pending.push(
        launch(item).catch((error) => {
          deps.log(`Acquisition evidence ${item.name}: ${errorMessage(error)}`);
          return false;
        }),
      );
    }
    return (await Promise.all(pending)).every(Boolean);
  };
  if (!(await phase("ready"))) {
    deps.log("Ready acquisition failed; remaining expected refusals were not launched.");
    return 2;
  }
  return (await phase("failed:capacity_exhausted")) ? 0 : 2;
}
async function runDown(deps: BrokerBatchOrchestratorDeps): Promise<number> {
  const names = readBrokerClients(deps.batchDir, deps.fs);
  const launches = readState(deps).launches.map((row) => row.client);
  // Include clients started directly through proxy1, before this orchestrator existed.
  const direct = names.filter(
    (name) =>
      !launches.includes(name) &&
      deps.fs.exists(join(deps.batchDir, "sessions", name, "request.json")),
  );
  const order = [...new Set([...direct, ...launches].reverse())];
  if (order.some((name) => !names.includes(name))) {
    throw new Error("Launch evidence contains an unknown batch client.");
  }
  let failed = false;
  for (const name of order) {
    try {
      const code = await raceWithDeadline(() => deps.proxy(["close", "--client", name]), {
        timer: deps.timer,
        // Proxy close joins the driver before its 240s release wait and evidence join.
        timeoutMs: deps.cleanupTimeoutMs ?? BROKER_CLEANUP_TIMEOUT_MS + 45_000,
        label: `Close ${name}`,
      });
      failed ||= code !== 0;
    } catch (error) {
      deps.log(`Close ${name}: ${errorMessage(error)}`);
      failed = true;
    }
  }
  const ledger = ledgerFor(deps);
  const grants = ledger.entries.filter((row) => row.kind === "acquired");
  for (const grant of grants.filter(
    (grant) => !ledger.devices().some((row) => row.sessionUuid === grant.sessionUuid),
  )) {
    if (ledger.releaseComplete(grant)) {
      continue;
    }
    try {
      const status = await raceWithDeadline(
        () => deps.daemonClient.status(grant.requestId, ledger.token(grant)),
        {
          timer: deps.timer,
          timeoutMs: deps.cleanupTimeoutMs ?? BROKER_CLEANUP_TIMEOUT_MS,
          label: `Release receipt ${grant.client}`,
        },
      );
      if (
        status?.requestId !== grant.requestId ||
        status.sessionUuid !== grant.sessionUuid ||
        status.outcome !== "released" ||
        status.cleanupPending
      ) {
        throw new Error("Native device identity missing and settled release receipt unavailable.");
      }
      ledger.record("released", grant);
      deps.log(`Released ${grant.client}; native absence: not-verifiable (no device info).`);
    } catch (error) {
      deps.log(`Release receipt ${grant.client}: ${errorMessage(error)}`);
      failed = true;
    }
  }
  if (ledger.devices().length) {
    try {
      await assertReleasedAndAbsent({
        ledger,
        daemonClient: deps.daemonClient,
        timer: deps.timer,
        devicesView: deps.devicesView,
        budgetMs: deps.cleanupTimeoutMs ?? BROKER_CLEANUP_TIMEOUT_MS,
        log: deps.log,
      });
    } catch (error) {
      deps.log(`Release/absence: ${errorMessage(error)}`);
      failed = true;
    }
  }
  const unresolved = grants.filter((row) => !ledger.releaseComplete(row));
  for (const device of ledger.devices().filter((row) => ledger.hasEvent(row, "pooled"))) {
    deps.log(
      `Pooled ${device.client} on ${device.device!.name}: clean idle device retained by the broker pool.`,
    );
  }
  deps.log(
    `Leak report: ${unresolved.length} unverified grant(s) of ${grants.length}; ` +
      JSON.stringify(unresolved.map(({ client, sessionUuid }) => ({ client, sessionUuid }))),
  );
  return failed || unresolved.length ? 2 : 0;
}
function runReport(deps: BrokerBatchOrchestratorDeps): number {
  const launches = readState(deps).launches;
  const ledger = ledgerFor(deps);
  const { plan } = expectationPlan({ op: "report", staggerMs: 0, maxDevices: 4 }, deps);
  const clients = readBrokerClients(deps.batchDir, deps.fs).map((client) => {
    const launch = launches.findLast((row) => row.client === client);
    const expected = launch?.expected ?? plan.find((row) => row.name === client)?.expected;
    const session = readSession(client, deps);
    const actual =
      session?.outcome === "failed"
        ? `failed:${session.failure?.code}`
        : (session?.outcome ?? "not_started");
    return {
      client,
      outcome: session?.outcome ?? "not_started",
      failure: session?.failure,
      sessionUuid: session?.sessionUuid ?? null,
      expected: expected ?? null,
      actual,
      matchesExpected: expected === actual && launch?.exitCode === 0,
      acquisitionDurationMs: launch?.durationMs ?? null,
      devices: ledger
        .devices()
        .filter((row) => row.client === client && row.sessionUuid === session?.sessionUuid)
        .map((row) => row.device),
    };
  });
  const summary = {
    grants: ledger.entries.filter((row) => row.kind === "acquired").length,
    devices: ledger.devices().length,
    released: ledger.devices().filter((row) => ledger.hasEvent(row, "released")).length,
    absent: ledger.devices().filter((row) => ledger.hasEvent(row, "absent")).length,
    pooled: ledger.devices().filter((row) => ledger.hasEvent(row, "pooled")).length,
  };
  writeEvidence(
    "broker-report.json",
    { clients, launches, ledger: { summary, entries: ledger.entries } },
    deps,
  );
  deps.log(
    [
      "client\tactual\texpected\tmatch\tacquisitionMs\tsessionUuid\tdevice",
      ...clients.map((row) =>
        [
          row.client,
          row.actual,
          row.expected ?? "-",
          row.matchesExpected ?? "-",
          row.acquisitionDurationMs ?? "-",
          row.sessionUuid ?? "-",
          JSON.stringify(row.devices),
        ].join("\t"),
      ),
      `ledger\t${JSON.stringify(summary)}`,
    ].join("\n"),
  );
  return 0;
}
/** Redact all output, including errors from injected I/O, at the orchestration boundary. */
export async function runBrokerBatchCommand(
  command: BrokerBatchCommand,
  deps: BrokerBatchOrchestratorDeps,
): Promise<number> {
  const original = deps;
  let names: string[];
  try {
    names = readBrokerClients(original.batchDir, original.fs);
  } catch (error) {
    // Parser diagnostics may quote credentials; no reliable token inventory exists yet.
    original.log("broker-batch: cannot read the broker client table; inspect broker/clients.json.");
    return 2;
  }
  const redact = (text: string): string => {
    for (const name of names) {
      const path = join(original.batchDir, "sessions", name, "owner-token");
      const token = original.fs.exists(path) ? original.fs.readFile(path) : "";
      if (token) {
        text = text
          .replaceAll(token, "[REDACTED]")
          .replaceAll(JSON.stringify(token).slice(1, -1), "[REDACTED]");
      }
    }
    return text;
  };
  deps = {
    ...deps,
    log: (text) => original.log(redact(text)),
    fs: { ...deps.fs, writeFile: (path, text) => original.fs.writeFile(path, redact(text)) },
  };
  try {
    if (command.op === "status") {
      return await deps.proxy(["status", "--all"]);
    }
    if (command.op === "up") {
      return await runUp(command, deps);
    }
    return command.op === "down" ? await runDown(deps) : runReport(deps);
  } catch (error) {
    deps.log(`broker-batch: ${errorMessage(error)}`);
    return 2;
  }
}
const devicesViewSchema = z.object({
  devices: z.array(
    z.object({
      name: z.string(),
      deviceId: z.string(),
      platform: z.enum(["android", "ios"]),
    }),
  ),
  daemons: z.array(z.object({ alive: z.boolean(), error: z.string().optional() })),
});
/**
 * `private-daemon devices` mixes one JSON inventory line with human-readable diagnostics
 * (for example "Private daemon command failed: ..."). Take the inventory from the lines that
 * parse as one, and surface the diagnostics instead of a JSON.parse crash when it is absent.
 */
export function parseDevicesViewOutput(code: number, lines: readonly string[]): LedgerDevicesView {
  let view: LedgerDevicesView | undefined;
  for (const line of lines) {
    try {
      view = devicesViewSchema.parse(JSON.parse(line));
    } catch {
      // Diagnostic lines are not inventory JSON; they are reported below if no view arrives.
    }
  }
  if (code !== 0 || !view) {
    const detail = lines.filter((line) => line.trim()).join(" | ");
    throw new Error(
      `Batch device inventory unavailable (exit ${code})${detail ? `: ${detail}` : ""}.`,
    );
  }
  return view;
}
async function realDeps(): Promise<BrokerBatchOrchestratorDeps> {
  const proxy = createProxySessionDeps();
  if (!proxy.env.MT_BATCH) {
    throw new Error("Use <batch>/bin/broker1; MT_BATCH is required.");
  }
  const batchDir = resolve(proxy.env.MT_BATCH);
  const daemon = await createPrivateDaemonDeps();
  return {
    batchDir,
    fs: proxy,
    timer: proxy.timer,
    daemonClient: createFrameBrokerDaemonClient({
      socketPath: brokerSocketPath(proxy),
      timer: proxy.timer,
      ids: proxy.ids,
    }),
    preflight: () => runPrivateDaemonCommand({ op: "preflight", batchDir, strict: true }, daemon),
    probe: (options) =>
      probeControlSocket(
        brokerSocketPath(proxy),
        { connect: connectFrameSocket, timer: proxy.timer, ids: proxy.ids },
        options,
      ),
    spawnClient: async (argv) =>
      (
        await daemon.runCommand(
          process.execPath,
          [fileURLToPath(new URL("./private-daemon.ts", import.meta.url)), ...argv],
          definedEnv(proxy.env),
        )
      ).exitCode,
    proxy: (argv) => {
      const command = parseProxySessionArgs(argv);
      if ("help" in command || "error" in command) {
        throw new Error("Invalid internal proxy command.");
      }
      return runProxySessionCommand(command, proxy);
    },
    devicesView: async () => {
      const lines: string[] = [];
      const code = await runPrivateDaemonCommand(
        { op: "devices", batchDir, daemon: 1, timeoutMs: 5000, extraFlags: [] },
        { ...daemon, log: (text) => lines.push(text) },
      );
      return parseDevicesViewOutput(code, lines);
    },
    isPidAlive: proxy.isPidAlive,
    log: proxy.log,
  };
}
export async function main(): Promise<number> {
  const command = parseBrokerBatchArgs(process.argv.slice(2));
  if ("help" in command) {
    console.log(command.help);
    return 0;
  }
  if ("error" in command) {
    console.error(command.error);
    return 2;
  }
  try {
    return await runBrokerBatchCommand(command, await realDeps());
  } catch (error) {
    console.error(`broker-batch: ${errorMessage(error)}`);
    return 2;
  }
}
if (import.meta.main) {
  process.exitCode = await main();
}
