#!/usr/bin/env bun
import "./harnessLogSink";
import { harnessChildEnvironment, type HarnessLogSinkOverride } from "./harnessLogSink";
/** Private manual-test launcher. Signals only a recorded daemon PID whose identity the private
 * control socket confirmed. Never signals device processes or deletes directories, devices,
 * AVDs or simulators. Unconfirmed daemon stops delegate to the product CLI. */
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import {
  encodeAdbHostRequest,
  AdbHostResponseAccumulator,
  type AdbHostResponse,
} from "./adbHostQuery";
import { homedir, userInfo, platform, loadavg, cpus, freemem, totalmem } from "node:os";
import { tryAcquireExclusiveLock, releaseExclusiveLock } from "../../src/utils/fileLock";
import { hostPreflight, recordHostPreflight, type HostStats } from "./hostPreflight";
import { bootGate, bootGateOptions, BOOT_GATE_FLAGS, type BootGateCommand } from "./bootGate";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { defaultTimer, type Timer } from "../../src/utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../../src/utils/IdGenerator";
import { SESSION_BROKER_HOST_CONFIG_ENV } from "../../src/daemon/sessionBroker/hostConfig";
import {
  BrokerBatchRequestIds,
  parseBrokerBatch,
  renderClientRequest,
  renderHostConfig,
  planExpectations,
} from "./brokerBatch";
import { probeControlSocket, type ControlSocketProbeResult } from "./controlSocketProbe";
import { privateDaemonStatus, privateDaemonDeviceStatus } from "./privateDaemonStatus";
import { PRODUCT_PATH_ENV_VARIABLES } from "./productPathEnv";
import type { PidFileData } from "../../src/daemon/types";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { ensureSecureDirectorySync } from "../../src/utils/tempDir";
import { isProcessRunning } from "../../src/utils/processLiveness";
import {
  privateClientEnvironment,
  canonicalizeHostPath,
  derivePrivateDaemonBatch,
  privateDaemonBatchRefusal,
  renderEnvFile,
  type HostDefaults,
  type PrivateDaemonBatchOptions,
  type PrivateDaemonSpec,
} from "./privateDaemonEnv";

import { createLockOwnerGenerationProbe } from "../../src/daemon/lockOwnerGeneration";
import type { LockOwnerGenerationProbe } from "../../src/utils/fileLock";
import { privateDaemonStop } from "./privateDaemonStop";
import {
  privateDaemonDevices,
  recordHostBaseline,
  type BatchDevicesCommand,
} from "./privateDaemonDevices";

export type PrivateDaemonCommand =
  | BootGateCommand
  | { op: "preflight"; batchDir: string; strict: boolean }
  | BatchDevicesCommand
  | {
      op: "init";
      options: PrivateDaemonBatchOptions;
      brokerBatch?: string;
      maxDevices?: number;
      allowReuse?: boolean;
      dryRun?: boolean;
    }
  | {
      op: "start" | "stop" | "status" | "env" | "wrappers";
      batchDir: string;
      daemon?: number;
      extraFlags: string[];
      devices?: boolean;
      waitMs?: number;
      crash?: boolean;
    };
const optionsSchema = z
  .object({
    batchDir: z.string(),
    count: z.number(),
    basePort: z.number(),
    auxRoot: z.string().optional(),
    serverPath: z.string(),
    splitAdbCoordination: z.boolean().optional(),
    protectedDevices: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => !value.startsWith("--")),
      )
      .optional(),
    orphanIdleMs: z.number().optional(),
    extraEnv: z.record(z.string()).optional(),
    daemonEnv: z.record(z.record(z.string())).optional(),
    daemonArgs: z.array(z.string()).optional(),
    daemonArgsByDaemon: z.record(z.array(z.string())).optional(),
  })
  .strict();
const brokerManifestSchema = z
  .object({ daemon: z.literal(1), hostConfig: z.literal("broker/host-config.json") })
  .strict();
type BrokerManifest = z.infer<typeof brokerManifestSchema>;
interface PrivateBatch {
  options: PrivateDaemonBatchOptions;
  specs: PrivateDaemonSpec[];
  broker?: BrokerManifest;
}
const manifestSchema = z
  .object({
    options: optionsSchema,
    specs: z.array(z.unknown()),
    broker: brokerManifestSchema.optional(),
  })
  .strict();
import { PRIVATE_DAEMON_COMMANDS, privateDaemonHelp } from "./privateDaemonHelp";
import { extraEnvRefusal, daemonArgsRefusal } from "./privateDaemonEnv";
import { writePrivateDaemonWrappers } from "./privateDaemonWrappers";
const commands: readonly string[] = PRIVATE_DAEMON_COMMANDS;
interface ParsedValues {
  values: Record<string, string>;
  extraEnv: Record<string, string>;
  daemonEnv: Record<string, Record<string, string>>;
  daemonArgs: string[];
  daemonArgsByDaemon: Record<string, string[]>;
  extraFlags: string[];
  split: boolean;
  allowReuse: boolean;
  devices: boolean;
  ledger: boolean;
  protectedDevices: string[];
  deviceSelectors: string[];
  dryRun: boolean;
  strict: boolean;
  crash: boolean;
  bootCommand: string[];
}
function recordEnvironment(state: ParsedValues, flag: string, token: string): string | undefined {
  const match = flag === "--daemon-env" ? /^(\d+):(.*)$/.exec(token) : undefined;
  if (flag === "--daemon-env" && !match) {
    return "--daemon-env requires N:K=V.";
  }
  const value = match ? match[2] : token;
  const eq = value.indexOf("=");
  if (eq < 1) {
    return `${flag} requires K=V.`;
  }
  const target = match ? (state.daemonEnv[match[1]] ??= {}) : state.extraEnv;
  const key = value.slice(0, eq);
  if (match && target[key] !== undefined) {
    return `Duplicate ${flag} assignment ${token}.`;
  }
  target[key] = value.slice(eq + 1);
  return extraEnvRefusal(target);
}
function recordDaemonArg(state: ParsedValues, token: string): void {
  const match = /^(\d+):(.*)$/.exec(token);
  if (match) {
    (state.daemonArgsByDaemon[match[1]] ??= []).push(match[2]);
  } else {
    state.daemonArgs.push(token);
  }
}
function assignValue(state: ParsedValues, flag: string, value: string): string | undefined {
  if (flag === "--protect" || flag === "--device") {
    (flag === "--protect" ? state.protectedDevices : state.deviceSelectors).push(value);
    return undefined;
  }
  if (flag === "--daemon-arg") {
    recordDaemonArg(state, value);
    return undefined;
  }
  if (flag === "--env" || flag === "--daemon-env") {
    return recordEnvironment(state, flag, value);
  }
  if (state.values[flag] !== undefined) {
    return `Duplicate flag ${flag}.`;
  }
  state.values[flag] = value;
  return undefined;
}
function valueFlagsForCommand(op: string): string[] {
  if (op === "boot-gate") {
    return BOOT_GATE_FLAGS;
  }
  if (op === "preflight") {
    return ["--batch-dir"];
  }
  if (op === "init") {
    return [
      "--batch-dir",
      "--count",
      "--base-port",
      "--aux-root",
      "--server",
      "--orphan-idle-ms",
      "--env",
      "--daemon-env",
      "--daemon-arg",
      "--protect",
      "--broker-batch",
      "--max-devices",
    ];
  }
  const flags = ["--batch-dir", "--daemon"];
  if (op === "stop") {
    flags.push("--wait-ms");
  }
  if (op === "devices" || op === "shutdown-devices") {
    flags.push("--timeout-ms");
  }
  if (op === "shutdown-devices") {
    flags.push("--device");
  }
  return flags;
}
function readValueArgument(
  op: string,
  args: string[],
  i: number,
  state: ParsedValues,
): { next: number; error?: string } {
  const inline = args[i].startsWith("--daemon-arg=");
  const flag = inline ? "--daemon-arg" : args[i];
  const allowed = valueFlagsForCommand(op);
  if (!allowed.includes(flag)) {
    return { next: i, error: `Unknown flag ${flag} for ${op}.` };
  }
  const next = inline ? i : i + 1;
  const value = inline ? args[i].slice("--daemon-arg=".length) : args[next];
  if (value === undefined || (flag !== "--daemon-arg" && (!value || value.startsWith("--")))) {
    return { next, error: `Missing value for ${flag}.` };
  }
  return { next, error: assignValue(state, flag, value) };
}
function readArguments(op: string, args: string[], state: ParsedValues): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (["--help", "-h"].includes(raw)) {
      return "HELP";
    }
    if (raw === "--") {
      return readPassthrough(op, args.slice(i + 1), state);
    }
    if (readBooleanFlag(op, raw, state)) {
      continue;
    }
    const result = readValueArgument(op, args, i, state);
    if (result.error) {
      return result.error;
    }
    i = result.next;
  }
  return daemonArgsRefusal([
    ...state.extraFlags,
    ...state.daemonArgs,
    ...Object.values(state.daemonArgsByDaemon).flat(),
  ]);
}
function readPassthrough(op: string, tokens: string[], state: ParsedValues): string | undefined {
  if (op === "boot-gate") {
    if (!tokens.length) {
      return "-- requires a command.";
    }
    state.bootCommand = tokens;
    return undefined;
  }
  if (op !== "start") {
    return "Only start and boot-gate accept -- passthrough.";
  }
  state.extraFlags.push(...tokens);
  return daemonArgsRefusal(tokens);
}
function readBooleanFlag(op: string, flag: string, state: ParsedValues): boolean {
  if (op === "init" && (flag === "--dry-run" || flag === "--allow-reuse")) {
    state[flag === "--dry-run" ? "dryRun" : "allowReuse"] = true;
    return true;
  }
  const flags: Record<
    string,
    { op: string; key: "split" | "dryRun" | "devices" | "strict" | "ledger" | "crash" }
  > = {
    "--split-adb-coordination": { op: "init", key: "split" },
    "--dry-run": { op: "shutdown-devices", key: "dryRun" },
    "--devices": { op: "status", key: "devices" },
    "--ledger": { op: "devices", key: "ledger" },
    "--crash": { op: "stop", key: "crash" },
    "--strict": { op: "preflight", key: "strict" },
  };
  const match = flags[flag];
  if (!match || match.op !== op) {
    return false;
  }
  state[match.key] = true;
  return true;
}
function initOptions(state: ParsedValues): PrivateDaemonCommand | { error: string } {
  const { values } = state;
  if (!values["--count"] || !values["--base-port"]) {
    return { error: "init requires --count and --base-port." };
  }
  const options: PrivateDaemonBatchOptions = {
    batchDir: values["--batch-dir"],
    count: Number(values["--count"]),
    basePort: Number(values["--base-port"]),
    serverPath: values["--server"] ?? resolve(import.meta.dir, "../../dist/src/index.js"),
    extraEnv: state.extraEnv,
    daemonEnv: state.daemonEnv,
    daemonArgs: state.daemonArgs,
    daemonArgsByDaemon: state.daemonArgsByDaemon,
    splitAdbCoordination: state.split,
    auxRoot: values["--aux-root"],
    ...(state.protectedDevices.length ? { protectedDevices: state.protectedDevices } : {}),
    orphanIdleMs: Number(values["--orphan-idle-ms"] ?? 0),
  };
  if (![options.count, options.basePort, options.orphanIdleMs].every(Number.isSafeInteger)) {
    return { error: "count, base-port and orphan-idle-ms must be integers." };
  }
  if (
    [...Object.keys(state.daemonEnv), ...Object.keys(state.daemonArgsByDaemon)].some(
      (index) => !/^[1-9]\d*$/.test(index) || Number(index) > options.count,
    )
  ) {
    return { error: "Per-daemon option index is outside --count." };
  }
  const brokerBatch = values["--broker-batch"];
  const maxDevices = durationArgument(values["--max-devices"], 2, 1);
  if (maxDevices === undefined || maxDevices > 4) {
    return { error: "--max-devices must be an integer from 1 to the hard ceiling of 4." };
  }
  if (!brokerBatch && (values["--max-devices"] !== undefined || state.allowReuse)) {
    return { error: "--max-devices and --allow-reuse require --broker-batch." };
  }
  return {
    op: "init",
    options,
    ...(brokerBatch ? { brokerBatch, maxDevices, allowReuse: state.allowReuse } : {}),
    ...(state.dryRun ? { dryRun: true } : {}),
  };
}
export function parsePrivateDaemonArgs(
  argv: string[],
): PrivateDaemonCommand | { error: string } | { help: string } {
  const [op, ...args] = argv;
  if (
    ["--help", "-h", "help"].includes(op) ||
    (commands.includes(op) && ["--help", "-h"].includes(args[0]))
  ) {
    return { help: privateDaemonHelp() };
  }
  if (!commands.includes(op)) {
    return { error: "Expected a private-daemon subcommand." };
  }
  const state: ParsedValues = {
    values: {},
    extraEnv: {},
    daemonEnv: {},
    daemonArgs: [],
    daemonArgsByDaemon: {},
    extraFlags: [],
    split: false,
    allowReuse: false,
    devices: false,
    ledger: false,
    protectedDevices: [],
    deviceSelectors: [],
    dryRun: false,
    strict: false,
    crash: false,
    bootCommand: [],
  };
  const error = readArguments(op, args, state);
  if (error === "HELP") {
    return { help: privateDaemonHelp() };
  }
  if (error) {
    return { error };
  }
  if (!state.values["--batch-dir"]) {
    return { error: "--batch-dir is required." };
  }
  if (op === "init") {
    return initOptions(state);
  }
  if (op === "preflight") {
    return { op, batchDir: state.values["--batch-dir"], strict: state.strict };
  }
  if (op === "boot-gate") {
    return bootGateOptions(state.values, state.bootCommand);
  }
  return existingCommand(op, state);
}
function existingCommand(
  op: string,
  state: ParsedValues,
): ExistingBatchCommand | { error: string } {
  const raw = state.values["--daemon"];
  const daemon = raw === undefined ? undefined : durationArgument(raw, 1, 1);
  if (raw !== undefined && daemon === undefined) {
    return { error: "--daemon must be a positive integer." };
  }
  if ((op === "stop" || op === "env") && daemon === undefined) {
    return { error: `${op} requires --daemon K.` };
  }
  if (op === "devices" || op === "shutdown-devices") {
    return deviceCommand(op, state, daemon);
  }
  const waitMs = durationArgument(state.values["--wait-ms"], 30000, 0);
  if (waitMs === undefined) {
    return { error: "--wait-ms must be an integer >= 0." };
  }
  return {
    op: op as "start" | "stop" | "status" | "env" | "wrappers",
    batchDir: state.values["--batch-dir"],
    daemon,
    extraFlags: state.extraFlags,
    devices: state.devices,
    ...(op === "stop" ? { waitMs, ...(state.crash ? { crash: true } : {}) } : {}),
  };
}
function deviceCommand(
  op: "devices" | "shutdown-devices",
  state: ParsedValues,
  daemon: number | undefined,
): BatchDevicesCommand | { error: string } {
  const timeoutMs = durationArgument(
    state.values["--timeout-ms"],
    op === "devices" ? 30000 : 60000,
    1,
  );
  if (timeoutMs === undefined) {
    return { error: "--timeout-ms must be a positive integer." };
  }
  return {
    op,
    batchDir: state.values["--batch-dir"],
    daemon,
    extraFlags: [],
    timeoutMs,
    ...(op === "devices" ? { ledger: state.ledger } : {}),
    ...(op === "shutdown-devices"
      ? { deviceSelectors: state.deviceSelectors, dryRun: state.dryRun }
      : {}),
  };
}
function durationArgument(
  raw: string | undefined,
  fallback: number,
  minimum: number,
): number | undefined {
  const value = Number(raw ?? fallback);
  return (raw === undefined || /^\d+$/.test(raw)) && Number.isSafeInteger(value) && value >= minimum
    ? value
    : undefined;
}
export interface PrivateDaemonCliDeps {
  ids?: IdGenerator;
  processGeneration?: LockOwnerGenerationProbe;
  timer: Timer;
  hostStats(): HostStats;
  bootLock: { tryAcquire(path: string, role: string): boolean; release(path: string): void };
  signalPid(pid: number, signal: NodeJS.Signals): void;
  requestSocket(
    path: string,
    request: { method: string; params?: unknown; timeoutMs: number },
  ): Promise<{ success: boolean; result?: unknown; error?: string; code?: string | number }>;

  runtimePath: string;
  repoRoot: string;
  removeFile(path: string): void;
  chmod(path: string, mode: number): void;
  runCapture(
    command: string,
    args: string[],
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  probeSocket(
    path: string,
    options?: { method?: string; timeoutMs?: number },
  ): Promise<ControlSocketProbeResult>;
  queryAdbHost(host: string, port: number, request: string, timeoutMs: number): Promise<string>;
  runCommand(
    command: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<{ exitCode: number }>;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  mkdir(path: string, mode: number): void;
  exists(path: string): boolean;
  isPidAlive(pid: number): boolean;
  host: HostDefaults;
  log(message: string): void;
  env: Record<string, string | undefined>;
  logSinkOverride?: readonly HarnessLogSinkOverride[];
}
function pidRecord(path: string, deps: PrivateDaemonCliDeps): Pick<PidFileData, "pid"> | undefined {
  if (!deps.exists(path)) {
    return undefined;
  }
  const data = z
    .object({ pid: z.number().int().positive() })
    .parse(JSON.parse(deps.readFile(path)));
  return data;
}
function olderManifestMessage(
  actual: unknown[],
  expected: PrivateDaemonSpec[],
): string | undefined {
  const legacy = structuredClone(expected);
  const missing = new Set<string>();
  for (let i = 0; i < legacy.length; i++) {
    const old = z
      .object({ env: z.record(z.string()) })
      .passthrough()
      .safeParse(actual[i]);
    if (!old.success) {
      return undefined;
    }
    for (const row of PRODUCT_PATH_ENV_VARIABLES.filter(
      (row) => row.kind === "state" && row.owner !== "harness",
    )) {
      if (!(row.name in old.data.env)) {
        delete legacy[i].env[row.name];
        missing.add(row.name);
      }
    }
  }
  return missing.size && isDeepStrictEqual(actual, legacy)
    ? `batch.json was written by an older harness (missing ${[...missing].join(", ")}); create a new batch with init`
    : undefined;
}
export function readPrivateBatch(batchDir: string, deps: PrivateDaemonCliDeps): PrivateBatch {
  validateBatchPath(batchDir, deps);
  const manifest = manifestSchema.parse(JSON.parse(deps.readFile(join(batchDir, "batch.json"))));
  const options = manifest.options;
  const specs = derivePrivateDaemonBatch(options);
  if (resolve(options.batchDir) !== resolve(batchDir)) {
    throw new Error("Tampered batch manifest: batch directory does not match.");
  }
  if (!isDeepStrictEqual(manifest.specs, specs)) {
    throw new Error(
      olderManifestMessage(manifest.specs, specs) ??
        "Tampered batch manifest: options/specs must match the canonical private derivation.",
    );
  }
  return { options, specs, ...(manifest.broker ? { broker: manifest.broker } : {}) };
}
function validateBatchPath(batchDir: string, deps: PrivateDaemonCliDeps): void {
  // Validate the requested path before any host probe or manifest read.
  const provisional: PrivateDaemonBatchOptions = {
    batchDir,
    count: 1,
    basePort: 3160,
    serverPath: resolve(import.meta.dir, "../../dist/src/index.js"),
  };
  const pathError = privateDaemonBatchRefusal(
    derivePrivateDaemonBatch(provisional),
    provisional,
    deps.host,
  );
  if (pathError) {
    throw new Error(pathError);
  }
}
function initializeBatch(batch: PrivateBatch, deps: PrivateDaemonCliDeps): void {
  const { options, specs, broker } = batch;
  const manifestPath = join(options.batchDir, "batch.json");
  if (deps.exists(manifestPath)) {
    throw new Error("batch.json already exists; choose a new --batch-dir.");
  }
  deps.mkdir(options.batchDir, 0o700);
  for (const spec of specs) {
    const directories = [
      spec.dir,
      spec.auxSocketDir,
      spec.logDir,
      spec.adbServerCoordinationDir,
      spec.env.AUTOMOBILE_DATA_DIR,
      spec.env.AUTOMOBILE_DB_DIR,
      spec.env.AUTOMOBILE_COORDINATION_DIR,
      ...PRODUCT_PATH_ENV_VARIABLES.filter((row) => row.kind === "state" && row.subpath).map(
        (row) => spec.env[row.name],
      ),
    ];
    for (const dir of new Set(directories)) {
      deps.mkdir(dir, 0o700);
    }
    deps.writeFile(join(spec.dir, "env.sh"), renderEnvFile(spec, options));
  }
  deps.writeFile(
    manifestPath,
    JSON.stringify({ options, specs, ...(broker ? { broker } : {}) }, null, 2),
  );
  writePrivateDaemonWrappers(options.batchDir, specs, deps);
}
function assertBrokerPaths(batch: PrivateBatch, deps: PrivateDaemonCliDeps): void {
  if (!batch.broker) {
    return;
  }
  // Production's injected canonicalizer is canonicalizeHostPath, including dangling symlinks.
  const root = deps.host.canonicalize(batch.options.batchDir);
  const spec = batch.specs[0];
  for (const path of [
    spec.env.AUTOMOBILE_COORDINATION_DIR,
    spec.env.AUTOMOBILE_ADB_SERVER_COORDINATION_DIR,
    join(batch.options.batchDir, "broker"),
    join(batch.options.batchDir, batch.broker.hostConfig),
    join(batch.options.batchDir, "broker/clients.json"),
  ]) {
    const rel = relative(root, deps.host.canonicalize(path));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(
        "Broker registry/coordination and configuration paths must be under the batch root.",
      );
    }
  }
}
function brokerInitFiles(
  command: Extract<PrivateDaemonCommand, { op: "init" }>,
  deps: PrivateDaemonCliDeps,
): Record<string, string> {
  if (!command.brokerBatch) {
    return {};
  }
  const batch = parseBrokerBatch(JSON.parse(deps.readFile(command.brokerBatch)), command);
  const ids = new BrokerBatchRequestIds(deps.ids ?? defaultIdGenerator);
  const expectations = planExpectations(batch);
  const clients = Object.fromEntries(
    batch.clients.map((client, index) => {
      const request = renderClientRequest(client, ids.next(client.name));
      return [
        client.name,
        {
          platform: client.platform,
          profile: request.device,
          requestId: request.requestId,
          tokenFile: `sessions/${client.name}/owner-token`,
          ...(request.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: request.idleTimeoutMs }),
          ...(request.preparationTimeoutMs === undefined
            ? {}
            : { preparationTimeoutMs: request.preparationTimeoutMs }),
          expected: expectations[index].expected,
        },
      ];
    }),
  );
  return {
    "broker/host-config.json": JSON.stringify(renderHostConfig(batch), null, 2),
    "broker/clients.json": JSON.stringify(clients, null, 2),
  };
}
async function runInit(
  command: Extract<PrivateDaemonCommand, { op: "init" }>,
  batch: PrivateBatch,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  assertBrokerPaths(batch, deps);
  const brokerFiles = brokerInitFiles(command, deps);
  const files = new Map<string, { path: string; mode: string; content: string }>();
  const directories: Array<{ path: string; mode: string }> = [];
  const writer: PrivateDaemonCliDeps = command.dryRun
    ? {
        ...deps,
        mkdir: (path, mode) => {
          directories.push({ path, mode: mode.toString(8).padStart(4, "0") });
        },
        writeFile: (path, content) => {
          files.set(path, { path, mode: "0600", content });
        },
        chmod: (path, mode) => {
          files.get(path)!.mode = mode.toString(8).padStart(4, "0");
        },
      }
    : deps;
  initializeBatch(batch, writer);
  if (batch.broker) {
    writer.mkdir(join(batch.options.batchDir, "broker"), 0o700);
    for (const [name, content] of Object.entries(brokerFiles)) {
      const path = join(batch.options.batchDir, name);
      writer.writeFile(path, content);
      writer.chmod(path, 0o600);
    }
  }
  if (command.dryRun) {
    deps.log(
      JSON.stringify({
        dryRun: true,
        directories,
        files: [...files.values()],
        daemonEnvironments: batch.specs.map((spec) => ({
          daemon: spec.index,
          env: daemonEnvironmentOverrides(batch, spec),
        })),
        clientEnvironments: batch.specs.map((spec) => ({ daemon: spec.index, env: spec.env })),
      }),
    );
  } else {
    await recordHostPreflight(batch.options.batchDir, deps);
  }
  return 0;
}
function daemonStartEnvironment(
  batch: PrivateBatch,
  spec: PrivateDaemonSpec,
  deps: PrivateDaemonCliDeps,
): Record<string, string> {
  return privateClientEnvironment(
    harnessChildEnvironment(deps.env, deps.logSinkOverride),
    daemonEnvironmentOverrides(batch, spec),
  );
}
/** Dry runs show planned overrides, without printing inherited shell credentials. */
function daemonEnvironmentOverrides(
  batch: PrivateBatch,
  spec: PrivateDaemonSpec,
): Record<string, string> {
  const env = { ...spec.env };
  if (batch.broker?.daemon === spec.index) {
    env[SESSION_BROKER_HOST_CONFIG_ENV] = resolve(batch.options.batchDir, batch.broker.hostConfig);
  }
  return env;
}
type ExistingBatchCommand = Exclude<
  PrivateDaemonCommand,
  { op: "init" | "preflight" | "boot-gate" }
>;
function preflightStart(specs: PrivateDaemonSpec[], deps: PrivateDaemonCliDeps): void {
  for (const spec of specs) {
    const record = pidRecord(spec.pidFilePath, deps);
    if (record && deps.isPidAlive(record.pid)) {
      throw new Error(`${spec.name} already names a live pid; stop it explicitly first.`);
    }
  }
}
async function runLifecycle(
  command: ExistingBatchCommand,
  batch: PrivateBatch,
  spec: PrivateDaemonSpec,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  const { options } = batch;
  const args = [options.serverPath, "--daemon", command.op];
  if (command.op === "start") {
    args.push(
      "--port",
      String(spec.port),
      "--strict-port",
      ...(options.daemonArgs ?? []),
      ...(options.daemonArgsByDaemon?.[String(spec.index)] ?? []),
      ...command.extraFlags,
    );
  }
  const env =
    command.op === "start"
      ? daemonStartEnvironment(batch, spec, deps)
      : privateClientEnvironment(harnessChildEnvironment(deps.env, deps.logSinkOverride), spec.env);
  const result = await deps.runCommand(deps.runtimePath, args, env);
  if (result.exitCode !== 0) {
    return result.exitCode;
  }
  if (command.op === "start") {
    const record = pidRecord(spec.pidFilePath, deps);
    if (!record) {
      throw new Error(`${spec.name} started without a JSON pid file; inspect its launch log.`);
    }
    const startIdentity = deps.processGeneration?.current(record.pid);
    deps.writeFile(
      join(spec.dir, "daemon-start.json"),
      JSON.stringify({
        pid: record.pid,
        socketPath: spec.socketPath,
        pidFilePath: spec.pidFilePath,
        startIdentity,
        startedAt: deps.timer.now(),
      }),
    );
    deps.writeFile(spec.plainPidFilePath, `${record.pid}\n`);
    deps.log(
      JSON.stringify({
        name: spec.name,
        port: spec.port,
        pid: record.pid,
        socket: spec.socketPath,
        envFile: join(spec.dir, "env.sh"),
        args: args.slice(3),
      }),
    );
  }
  return 0;
}
async function logBatchStatus(
  specs: PrivateDaemonSpec[],
  devices: boolean,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  for (const spec of specs) {
    deps.log(JSON.stringify(await privateDaemonStatus(spec, deps)));
  }
  if (devices) {
    deps.log(JSON.stringify(await privateDaemonDeviceStatus(specs, deps)));
  }
  return 0;
}
function selectBatchSpecs(
  command: ExistingBatchCommand,
  specs: PrivateDaemonSpec[],
): PrivateDaemonSpec[] {
  const selected =
    command.daemon === undefined ? specs : specs.filter((spec) => spec.index === command.daemon);
  if (!selected.length) {
    throw new Error("--daemon is outside this batch.");
  }
  const argError = daemonArgsRefusal(command.extraFlags);
  if (argError) {
    throw new Error(argError);
  }
  return selected;
}
async function runExistingBatch(
  command: ExistingBatchCommand,
  batch: PrivateBatch,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  const { options, specs } = batch;
  const selected = selectBatchSpecs(command, specs);
  if (command.op === "stop") {
    return privateDaemonStop(selected[0], options, command.waitMs ?? 30000, deps, command.crash);
  }
  if (command.op === "devices" || command.op === "shutdown-devices") {
    return privateDaemonDevices(command, options, selected, deps);
  }
  if (command.op === "wrappers") {
    writePrivateDaemonWrappers(options.batchDir, selected, deps);
    return 0;
  }
  if (command.op === "status") {
    return logBatchStatus(selected, command.devices ?? false, deps);
  }
  if (command.op === "start") {
    assertBrokerPaths(batch, deps);
    preflightStart(selected, deps);
    await recordHostPreflight(options.batchDir, deps);
    await recordHostBaseline(options.batchDir, deps);
  }
  for (const spec of selected) {
    if (command.op === "env") {
      deps.log(join(spec.dir, "env.sh"));
      continue;
    }
    const code = await runLifecycle(command, batch, spec, deps);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
}
async function runPreflightCommand(
  command: Extract<PrivateDaemonCommand, { op: "preflight" }>,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  const report = await hostPreflight(command.batchDir, deps);
  deps.log(JSON.stringify(report));
  return command.strict && report.warnings.length ? 1 : 0;
}
export async function runPrivateDaemonCommand(
  command: PrivateDaemonCommand,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  try {
    if (command.op === "preflight") {
      validateBatchPath(command.batchDir, deps);
      return await runPreflightCommand(command, deps);
    }
    const batch: PrivateBatch =
      command.op === "init"
        ? {
            options: command.options,
            specs: derivePrivateDaemonBatch(command.options),
            ...(command.brokerBatch
              ? { broker: { daemon: 1, hostConfig: "broker/host-config.json" } as const }
              : {}),
          }
        : readPrivateBatch(command.batchDir, deps);
    const { options, specs } = batch;
    const refusal = privateDaemonBatchRefusal(specs, options, deps.host);
    if (refusal) {
      throw new Error(refusal);
    }
    if (
      (command.op === "init" || command.op === "wrappers") &&
      (!isAbsolute(deps.repoRoot) || deps.repoRoot.includes("\0"))
    ) {
      throw new Error("repoRoot must be an absolute path without NUL.");
    }
    if (command.op === "init") {
      return await runInit(command, batch, deps);
    }
    if (command.op === "boot-gate") {
      return await bootGate(command, deps);
    }
    return await runExistingBatch(command, batch, deps);
  } catch (error) {
    // The CLI reports refusals and I/O failures through its exit-2 boundary.
    deps.log(`Private daemon command failed: ${errorMessage(error)}`);
    return 2;
  }
}
export async function main(): Promise<number> {
  const parsed = parsePrivateDaemonArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`${parsed.error}\nRun private-daemon --help for usage.`);
    return 2;
  }
  if ("help" in parsed) {
    console.log(parsed.help);
    return 0;
  }
  return runPrivateDaemonCommand(parsed, await createPrivateDaemonDeps());
}
export async function createPrivateDaemonDeps(): Promise<PrivateDaemonCliDeps> {
  const { connectFrameSocket, connectWithDeadline, FrameRpc } = await import("./daemon-frame");
  return {
    timer: defaultTimer,
    hostStats: () => ({
      platform: platform(),
      loadAverage: loadavg(),
      cpuCount: cpus().length,
      freeMemoryBytes: freemem(),
      totalMemoryBytes: totalmem(),
    }),
    bootLock: {
      tryAcquire: (path, role) =>
        tryAcquireExclusiveLock(path, { pid: process.pid, metadata: role }),
      release: (path) => releaseExclusiveLock(path, process.pid),
    },
    processGeneration: createLockOwnerGenerationProbe({ sameVerdictTtlMs: 0 }),
    signalPid: (pid, signal) => {
      process.kill(pid, signal);
    },
    requestSocket: async (path, request) => {
      const startedAt = defaultTimer.now();
      const connection = await connectWithDeadline(
        connectFrameSocket,
        path,
        defaultTimer,
        request.timeoutMs,
      );
      const rpc = new FrameRpc(connection, {
        timer: defaultTimer,
        ids: defaultIdGenerator,
        out: () => {},
      });
      try {
        const remainingMs = request.timeoutMs - (defaultTimer.now() - startedAt);
        if (remainingMs <= 0) {
          throw new Error(`${request.method} timed out while connecting.`);
        }
        return await rpc.request(request.method, request.params, remainingMs);
      } finally {
        rpc.fail(new Error("Private daemon request finished."));
        connection.destroy();
      }
    },
    runtimePath: process.execPath,
    repoRoot: resolve(import.meta.dir, "../.."),
    removeFile: (path) => rmSync(path, { force: true }),
    chmod: chmodSync,
    probeSocket: (path, options) =>
      probeControlSocket(
        path,
        { connect: connectFrameSocket, timer: defaultTimer, ids: defaultIdGenerator },
        options,
      ),
    runCapture: (command, args, env, timeoutMs) =>
      new Promise((done) => {
        execFile(
          command,
          args,
          { env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            done({
              exitCode: error ? 1 : 0,
              stdout,
              stderr: stderr || (error ? errorMessage(error) : ""),
            });
          },
        );
      }),
    queryAdbHost: (host, port, request, timeoutMs) =>
      new Promise((done, reject) => {
        const socket = new Socket();
        const response = new AdbHostResponseAccumulator();
        let settled = false;
        const finish = (result: AdbHostResponse): void => {
          if (settled) {
            return;
          }
          settled = true;
          defaultTimer.clearTimeout(deadline);
          socket.destroy();
          if (result.ok) {
            done(result.payload);
          } else {
            reject(new Error(result.reason));
          }
        };
        const deadline = defaultTimer.setTimeout(
          () => finish({ ok: false, reason: "ADB host query timed out" }),
          timeoutMs,
        );
        socket.once("error", (error) => {
          // Preserve ECONNREFUSED so status can distinguish an absent server.
          if (!settled) {
            settled = true;
            defaultTimer.clearTimeout(deadline);
            socket.destroy();
            reject(error);
          }
        });
        socket.on("data", (chunk) => {
          if (settled) {
            return;
          }
          const result = response.push(chunk);
          if (result !== undefined) {
            finish(result);
          }
        });
        socket.once("end", () => finish(response.finish()));
        socket.once("close", () =>
          finish({ ok: false, reason: "ADB host socket closed without a response" }),
        );
        socket.connect(port, host, () => socket.write(encodeAdbHostRequest(request)));
      }),
    runCommand: async (command, args, env) => {
      const child = spawn(command, args, { env, stdio: "inherit" });
      return new Promise((done, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => done({ exitCode: code ?? 1 }));
      });
    },
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
    mkdir: (path) => {
      ensureSecureDirectorySync(path);
    },
    exists: existsSync,
    isPidAlive: isProcessRunning,
    host: {
      homeDirs: [homedir(), userInfo().homedir],
      uid: process.getuid?.() ?? userInfo().username,
      canonicalize: canonicalizeHostPath,
    },
    log: console.log,
    env: harnessChildEnvironment(process.env),
  };
}
if (import.meta.main) {
  process.exitCode = await main();
}
