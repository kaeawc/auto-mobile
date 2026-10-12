#!/usr/bin/env bun
import "./harnessLogSink";
import { harnessChildEnvironment, type HarnessLogSinkOverride } from "./harnessLogSink";
/** Private manual-test launcher. Never signals processes or deletes directories, devices, AVDs
 * or simulators. Stop delegates only to the explicitly isolated daemon's CLI. */
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { defaultIdGenerator } from "../../src/utils/IdGenerator";
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

export type PrivateDaemonCommand =
  | { op: "init"; options: PrivateDaemonBatchOptions }
  | {
      op: "start" | "stop" | "status" | "env" | "wrappers";
      batchDir: string;
      daemon?: number;
      extraFlags: string[];
      devices?: boolean;
    };
const optionsSchema = z
  .object({
    batchDir: z.string(),
    count: z.number(),
    basePort: z.number(),
    auxRoot: z.string().optional(),
    serverPath: z.string(),
    splitAdbCoordination: z.boolean().optional(),
    orphanIdleMs: z.number().optional(),
    extraEnv: z.record(z.string()).optional(),
    daemonEnv: z.record(z.record(z.string())).optional(),
    daemonArgs: z.array(z.string()).optional(),
    daemonArgsByDaemon: z.record(z.array(z.string())).optional(),
  })
  .strict();
const manifestSchema = z.object({ options: optionsSchema, specs: z.array(z.unknown()) }).strict();
import {
  PRIVATE_DAEMON_COMMANDS,
  PRIVATE_DAEMON_FLAGS,
  privateDaemonHelp,
} from "./privateDaemonHelp";
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
  devices: boolean;
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
function readValueArgument(
  op: string,
  args: string[],
  i: number,
  state: ParsedValues,
): { next: number; error?: string } {
  const inline = args[i].startsWith("--daemon-arg=");
  const flag = inline ? "--daemon-arg" : args[i];
  const allowed =
    op === "init"
      ? Object.keys(PRIVATE_DAEMON_FLAGS).filter(
          (key) =>
            !["--daemon", "--devices", "--", "--help", "--split-adb-coordination"].includes(key),
        )
      : ["--batch-dir", "--daemon"];
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
      if (op !== "start") {
        return "Only start accepts extra daemon flags.";
      }
      state.extraFlags.push(...args.slice(i + 1));
      break;
    }
    if (raw === "--split-adb-coordination" && op === "init") {
      state.split = true;
      continue;
    }
    if (raw === "--devices" && op === "status") {
      state.devices = true;
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
  return { op: "init", options };
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
    devices: false,
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
  return existingCommand(op, state);
}
function existingCommand(
  op: string,
  state: ParsedValues,
): ExistingBatchCommand | { error: string } {
  const raw = state.values["--daemon"];
  const daemon = raw === undefined ? undefined : Number(raw);
  if (raw !== undefined && (!/^\d+$/.test(raw) || !Number.isSafeInteger(daemon) || daemon! < 1)) {
    return { error: "--daemon must be a positive integer." };
  }
  if ((op === "stop" || op === "env") && daemon === undefined) {
    return { error: `${op} requires --daemon K.` };
  }
  return {
    op: op as "start" | "stop" | "status" | "env" | "wrappers",
    batchDir: state.values["--batch-dir"],
    daemon,
    extraFlags: state.extraFlags,
    devices: state.devices,
  };
}
export interface PrivateDaemonCliDeps {
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
  isTcpPortListening(host: string, port: number, timeoutMs: number): Promise<boolean>;
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
  logSinkOverride?: HarnessLogSinkOverride;
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
function readPrivateBatch(
  batchDir: string,
  deps: PrivateDaemonCliDeps,
): { options: PrivateDaemonBatchOptions; specs: PrivateDaemonSpec[] } {
  // Validate the requested read path before opening any manifest.
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
  return { options, specs };
}
function initializeBatch(
  options: PrivateDaemonBatchOptions,
  specs: PrivateDaemonSpec[],
  deps: PrivateDaemonCliDeps,
): void {
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
  deps.writeFile(manifestPath, JSON.stringify({ options, specs }, null, 2));
  writePrivateDaemonWrappers(options.batchDir, specs, deps);
}
type ExistingBatchCommand = Exclude<PrivateDaemonCommand, { op: "init" }>;
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
  options: PrivateDaemonBatchOptions,
  spec: PrivateDaemonSpec,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
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
  const result = await deps.runCommand(
    deps.runtimePath,
    args,
    privateClientEnvironment(harnessChildEnvironment(deps.env, deps.logSinkOverride), spec.env),
  );
  if (result.exitCode !== 0) {
    return result.exitCode;
  }
  if (command.op === "stop") {
    deps.removeFile(spec.plainPidFilePath);
  }
  if (command.op === "start") {
    const record = pidRecord(spec.pidFilePath, deps);
    if (!record) {
      throw new Error(`${spec.name} started without a JSON pid file; inspect its launch log.`);
    }
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
async function runExistingBatch(
  command: ExistingBatchCommand,
  options: PrivateDaemonBatchOptions,
  specs: PrivateDaemonSpec[],
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  const selected =
    command.daemon === undefined ? specs : specs.filter((spec) => spec.index === command.daemon);
  if (!selected.length) {
    throw new Error("--daemon is outside this batch.");
  }
  const argError = daemonArgsRefusal(command.extraFlags);
  if (argError) {
    throw new Error(argError);
  }
  if (command.op === "wrappers") {
    writePrivateDaemonWrappers(options.batchDir, selected, deps);
    return 0;
  }
  if (command.op === "status") {
    for (const spec of selected) {
      deps.log(JSON.stringify(await privateDaemonStatus(spec, deps)));
    }
    if (command.devices) {
      deps.log(JSON.stringify(await privateDaemonDeviceStatus(selected, deps)));
    }
    return 0;
  }
  if (command.op === "start") {
    preflightStart(selected, deps);
  }
  for (const spec of selected) {
    if (command.op === "env") {
      deps.log(join(spec.dir, "env.sh"));
      continue;
    }
    const code = await runLifecycle(command, options, spec, deps);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
}
export async function runPrivateDaemonCommand(
  command: PrivateDaemonCommand,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  try {
    const { options, specs } =
      command.op === "init"
        ? { options: command.options, specs: derivePrivateDaemonBatch(command.options) }
        : readPrivateBatch(command.batchDir, deps);
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
      initializeBatch(options, specs, deps);
      return 0;
    }
    return await runExistingBatch(command, options, specs, deps);
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
  const { connectFrameSocket } = await import("./daemon-frame");
  return runPrivateDaemonCommand(parsed, {
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
    isTcpPortListening: (host, port, timeoutMs) =>
      new Promise((done) => {
        const socket = new Socket();
        const finish = (alive: boolean): void => {
          defaultTimer.clearTimeout(deadline);
          socket.destroy();
          done(alive);
        };
        const deadline = defaultTimer.setTimeout(() => finish(false), timeoutMs);
        socket.once("error", () => finish(false));
        socket.connect(port, host, () => finish(true));
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
  });
}
if (import.meta.main) {
  process.exitCode = await main();
}
