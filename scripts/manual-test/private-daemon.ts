#!/usr/bin/env bun
/** Private manual-test launcher. Never signals processes or deletes directories, devices, AVDs
 * or simulators. Stop delegates only to the explicitly isolated daemon's CLI. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
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
      op: "start" | "stop" | "status" | "env";
      batchDir: string;
      daemon?: number;
      extraFlags: string[];
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
  })
  .strict();
const manifestSchema = z.object({ options: optionsSchema, specs: z.array(z.unknown()) }).strict();
const commands = ["init", "start", "stop", "status", "env"];
function ownedFlag(flag: string): boolean {
  return (
    flag === "--port" ||
    flag.startsWith("--port=") ||
    flag === "--strict-port" ||
    flag.startsWith("--strict-port=")
  );
}
export function parsePrivateDaemonArgs(argv: string[]): PrivateDaemonCommand | { error: string } {
  const [op, ...args] = argv;
  if (!commands.includes(op)) {
    return { error: "Usage: private-daemon <init|start|stop|status|env> --batch-dir B ..." };
  }
  const values: Record<string, string> = {};
  const extraEnv: Record<string, string> = {};
  const extraFlags: string[] = [];
  let split = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--") {
      if (op !== "start") {
        return { error: "Only start accepts extra daemon flags." };
      }
      extraFlags.push(...args.slice(i + 1));
      break;
    }
    if (flag === "--split-adb-coordination" && op === "init") {
      split = true;
      continue;
    }
    const allowed =
      op === "init"
        ? [
            "--batch-dir",
            "--count",
            "--base-port",
            "--aux-root",
            "--server",
            "--orphan-idle-ms",
            "--env",
          ]
        : ["--batch-dir", "--daemon"];
    if (!allowed.includes(flag)) {
      return { error: `Unknown flag ${flag} for ${op}.` };
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) {
      return { error: `Missing value for ${flag}.` };
    }
    if (flag === "--env") {
      const eq = value.indexOf("=");
      if (eq < 1) {
        return { error: "--env requires K=V." };
      }
      extraEnv[value.slice(0, eq)] = value.slice(eq + 1);
    } else if (values[flag] !== undefined) {
      return { error: `Duplicate flag ${flag}.` };
    } else {
      values[flag] = value;
    }
  }
  if (!values["--batch-dir"]) {
    return { error: "--batch-dir is required." };
  }
  if (extraFlags.some(ownedFlag)) {
    return { error: "The harness owns --port and --strict-port; remove them from extra flags." };
  }
  if (op === "init") {
    if (!values["--count"] || !values["--base-port"]) {
      return { error: "init requires --count and --base-port." };
    }
    const options: PrivateDaemonBatchOptions = {
      batchDir: values["--batch-dir"],
      count: Number(values["--count"]),
      basePort: Number(values["--base-port"]),
      serverPath:
        values["--server"] ??
        resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/src/index.js"),
      extraEnv,
      splitAdbCoordination: split,
      auxRoot: values["--aux-root"],
      orphanIdleMs: Number(values["--orphan-idle-ms"] ?? 0),
    };
    if (![options.count, options.basePort, options.orphanIdleMs].every(Number.isSafeInteger)) {
      return { error: "count, base-port and orphan-idle-ms must be integers." };
    }
    return { op, options };
  }
  const daemon = values["--daemon"] === undefined ? undefined : Number(values["--daemon"]);
  if (
    daemon !== undefined &&
    (!/^\d+$/.test(values["--daemon"]) || !Number.isSafeInteger(daemon) || daemon < 1)
  ) {
    return { error: "--daemon must be a positive integer." };
  }
  if ((op === "stop" || op === "env") && daemon === undefined) {
    return { error: `${op} requires --daemon K.` };
  }
  return {
    op: op as "start" | "stop" | "status" | "env",
    batchDir: values["--batch-dir"],
    daemon,
    extraFlags,
  };
}
export interface PrivateDaemonCliDeps {
  runtimePath: string;
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
export async function runPrivateDaemonCommand(
  command: PrivateDaemonCommand,
  deps: PrivateDaemonCliDeps,
): Promise<number> {
  const refuse = (message: string): number => {
    deps.log(message);
    return 2;
  };
  try {
    let options: PrivateDaemonBatchOptions;
    let specs: PrivateDaemonSpec[];
    const batchDir = command.op === "init" ? command.options.batchDir : command.batchDir;
    const manifestPath = join(batchDir, "batch.json");
    if (command.op === "init") {
      options = command.options;
      specs = derivePrivateDaemonBatch(options);
    } else {
      // Validate the requested read path before opening a manifest in a default state directory.
      options = {
        batchDir,
        count: 1,
        basePort: 3160,
        serverPath: resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/src/index.js"),
      };
      const pathError = privateDaemonBatchRefusal(
        derivePrivateDaemonBatch(options),
        options,
        deps.host,
      );
      if (pathError) {
        return refuse(pathError);
      }
      const manifest = manifestSchema.parse(JSON.parse(deps.readFile(manifestPath)));
      options = manifest.options;
      specs = derivePrivateDaemonBatch(options);
      if (
        resolve(options.batchDir) !== resolve(batchDir) ||
        !isDeepStrictEqual(manifest.specs, specs)
      ) {
        return refuse(
          "Tampered batch manifest: options/specs must match the canonical private derivation.",
        );
      }
    }
    const refusal = privateDaemonBatchRefusal(specs, options, deps.host);
    if (refusal) {
      return refuse(refusal);
    }
    if (command.op === "init") {
      if (deps.exists(manifestPath)) {
        return refuse("batch.json already exists; choose a new --batch-dir.");
      }
      deps.mkdir(batchDir, 0o700);
      for (const spec of specs) {
        for (const dir of new Set([
          spec.dir,
          spec.auxSocketDir,
          spec.logDir,
          spec.adbServerCoordinationDir,
          spec.env.AUTOMOBILE_DATA_DIR,
          spec.env.AUTOMOBILE_DB_DIR,
          spec.env.AUTOMOBILE_COORDINATION_DIR,
        ])) {
          deps.mkdir(dir, 0o700);
        }
        deps.writeFile(join(spec.dir, "env.sh"), renderEnvFile(spec, options));
      }
      deps.writeFile(manifestPath, JSON.stringify({ options, specs }, null, 2));
      return 0;
    }
    const selected =
      command.daemon === undefined ? specs : specs.filter((spec) => spec.index === command.daemon);
    if (!selected.length) {
      return refuse("--daemon is outside this batch.");
    }
    if (command.extraFlags.some(ownedFlag)) {
      return refuse("The harness owns --port and --strict-port.");
    }
    // Preflight the whole selection before launching any member.
    if (command.op === "start") {
      for (const spec of selected) {
        const record = pidRecord(spec.pidFilePath, deps);
        if (record && deps.isPidAlive(record.pid)) {
          return refuse(`${spec.name} already names a live pid; stop it explicitly first.`);
        }
      }
    }
    for (const spec of selected) {
      const envFile = join(spec.dir, "env.sh");
      if (command.op === "env") {
        deps.log(envFile);
        continue;
      }
      if (command.op === "status") {
        const pid = deps.exists(spec.plainPidFilePath)
          ? Number(deps.readFile(spec.plainPidFilePath).trim())
          : undefined;
        deps.log(
          JSON.stringify({
            name: spec.name,
            port: spec.port,
            pid,
            alive: pid !== undefined && Number.isInteger(pid) && pid > 0 && deps.isPidAlive(pid),
            socket: spec.socketPath,
            envFile,
          }),
        );
        continue;
      }
      const env = privateClientEnvironment(deps.env, spec.env);
      const args = [options.serverPath, "--daemon", command.op];
      if (command.op === "start") {
        args.push("--port", String(spec.port), "--strict-port", ...command.extraFlags);
      }
      const result = await deps.runCommand(deps.runtimePath, args, env);
      if (result.exitCode !== 0) {
        return result.exitCode;
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
            envFile,
          }),
        );
      }
    }
    return 0;
  } catch (error) {
    deps.log(`Private daemon command failed: ${errorMessage(error)}`);
    return 2;
  }
}
export async function main(): Promise<number> {
  const parsed = parsePrivateDaemonArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }
  return runPrivateDaemonCommand(parsed, {
    runtimePath: process.execPath,
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
    env: process.env,
  });
}
if (import.meta.main) {
  process.exitCode = await main();
}
