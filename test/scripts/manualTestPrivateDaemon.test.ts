import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  parsePrivateDaemonArgs,
  runPrivateDaemonCommand,
  type PrivateDaemonCliDeps,
  type PrivateDaemonCommand,
} from "../../scripts/manual-test/private-daemon";
import {
  derivePrivateDaemonBatch,
  type PrivateDaemonBatchOptions,
} from "../../scripts/manual-test/privateDaemonEnv";
const posixTest = process.platform === "win32" ? test.skip : test;
const options: PrivateDaemonBatchOptions = {
  batchDir: resolve("/mt-batch"),
  count: 2,
  basePort: 3160,
  auxRoot: resolve("/mt-aux"),
  serverPath: resolve("/built/index.js"),
};
function parsed(args: string[]): PrivateDaemonCommand {
  const result = parsePrivateDaemonArgs(args);
  if ("error" in result) {
    throw new Error(result.error);
  }
  return result;
}
function fixture() {
  const files = new Map<string, string>();
  const writes: string[] = [],
    dirs: Array<[string, number]> = [],
    logs: string[] = [];
  const launches: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const deps: PrivateDaemonCliDeps = {
    host: { homeDirs: [resolve("/home/fake")], uid: 4242 },
    env: {
      AUTOMOBILE_MANAGED_SLOT_CONFIG: "inherited",
      AUTOMOBILE_DB_PATH: "/wrong-db",
      KEEP: "kept",
    },
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) {
        throw new Error(`Missing fake file ${path}`);
      }
      return text;
    },
    writeFile: (path, text) => {
      files.set(path, text);
      writes.push(path);
    },
    mkdir: (path, mode) => {
      dirs.push([path, mode]);
    },
    exists: (path) => files.has(path),
    isPidAlive: () => false,
    log: (text) => {
      logs.push(text);
    },
    runCommand: async (command, args, env) => {
      launches.push({ command, args, env });
      if (args[2] === "start") {
        files.set(env.AUTOMOBILE_DAEMON_PID_FILE_PATH, JSON.stringify({ pid: 1234 }));
      }
      return { exitCode: 0 };
    },
  };
  return { files, writes, dirs, logs, launches, deps };
}
test("parses each command and exact start passthrough", () => {
  expect(
    parsed([
      "init",
      "--batch-dir",
      options.batchDir,
      "--count",
      "2",
      "--base-port",
      "3160",
      "--server",
      options.serverPath,
      "--env",
      "NOTE=a=b",
      "--split-adb-coordination",
      "--orphan-idle-ms",
      "0",
    ]).op,
  ).toBe("init");
  for (const op of ["start", "stop", "status", "env"]) {
    expect(parsed([op, "--batch-dir", options.batchDir, "--daemon", "1"]).op).toBe(op);
  }
  const start = parsed([
    "start",
    "--batch-dir",
    options.batchDir,
    "--",
    "--debug",
    "--plan-execution-lock-scope",
    "session",
  ]);
  if (start.op === "init") {
    throw new Error("wrong op");
  }
  expect(start.extraFlags).toEqual(["--debug", "--plan-execution-lock-scope", "session"]);
  expect(parsed(["status", "--batch-dir", options.batchDir]).op).toBe("status");
});
test("rejects missing values, unknown flags, invalid daemon and owned port flags", () => {
  for (const args of [
    [],
    ["init", "--batch-dir", "/batch"],
    ["start", "--batch-dir"],
    ["start", "--batch-dir", "/batch", "--wat"],
    ["env", "--batch-dir", "/batch"],
    ["stop", "--batch-dir", "/batch", "--daemon", "x"],
    ["start", "--batch-dir", "/batch", "--daemon", "0"],
    ["status", "--batch-dir", "/batch", "--", "--debug"],
    ...["--port", "--port=3190", "--strict-port", "--strict-port=false"].map((flag) => [
      "start",
      "--batch-dir",
      "/batch",
      "--",
      flag,
    ]),
  ]) {
    expect(parsePrivateDaemonArgs(args)).toHaveProperty("error");
  }
});
posixTest("init writes only private manifest/env/0700 dirs, refuses overwrite", async () => {
  const f = fixture();
  expect(await runPrivateDaemonCommand({ op: "init", options }, f.deps)).toBe(0);
  expect(f.writes).toEqual([
    join(options.batchDir, "daemon1", "env.sh"),
    join(options.batchDir, "daemon2", "env.sh"),
    join(options.batchDir, "batch.json"),
  ]);
  expect(f.dirs.every(([, mode]) => mode === 0o700)).toBe(true);
  expect(JSON.parse(f.files.get(join(options.batchDir, "batch.json"))!).specs).toEqual(
    derivePrivateDaemonBatch(options),
  );
  f.writes.length = 0;
  expect(await runPrivateDaemonCommand({ op: "init", options }, f.deps)).toBe(2);
  expect(f.writes).toEqual([]);
});
test("init refusal writes and creates nothing", async () => {
  const f = fixture();
  expect(
    await runPrivateDaemonCommand(
      { op: "init", options: { ...options, batchDir: "relative" } },
      f.deps,
    ),
  ).toBe(2);
  expect(f.writes).toEqual([]);
  expect(f.dirs).toEqual([]);
  expect(f.launches).toEqual([]);
});
posixTest("start uses strict owned port and derived env, writes a plain pid", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  expect(
    await runPrivateDaemonCommand(
      parsed(["start", "--batch-dir", options.batchDir, "--daemon", "1", "--", "--debug"]),
      f.deps,
    ),
  ).toBe(0);
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0].args).toEqual([
    options.serverPath,
    "--daemon",
    "start",
    "--port",
    "3160",
    "--strict-port",
    "--debug",
  ]);
  expect(f.launches[0].env).toEqual({ KEEP: "kept", ...derivePrivateDaemonBatch(options)[0].env });
  expect(f.files.get(join(options.batchDir, "daemon1", "pid.txt"))).toBe("1234\n");
  expect(JSON.parse(f.logs[0]).pid).toBe(1234);
});
posixTest("start refuses any live pid before launching the batch", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  f.files.set(derivePrivateDaemonBatch(options)[1].pidFilePath, '{"pid":1234}');
  f.deps.isPidAlive = () => true;
  expect(
    await runPrivateDaemonCommand(parsed(["start", "--batch-dir", options.batchDir]), f.deps),
  ).toBe(2);
  expect(f.launches).toEqual([]);
});
posixTest("stop only launches isolated daemon stop; status and env never launch", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  f.writes.length = 0;
  f.dirs.length = 0;
  expect(
    await runPrivateDaemonCommand(
      parsed(["stop", "--batch-dir", options.batchDir, "--daemon", "1"]),
      f.deps,
    ),
  ).toBe(0);
  expect(f.launches[0].args).toEqual([options.serverPath, "--daemon", "stop"]);
  expect(f.writes).toEqual([]);
  expect(f.dirs).toEqual([]);
  f.files.set(join(options.batchDir, "daemon1", "pid.txt"), "1234\n");
  await runPrivateDaemonCommand(parsed(["status", "--batch-dir", options.batchDir]), f.deps);
  await runPrivateDaemonCommand(
    parsed(["env", "--batch-dir", options.batchDir, "--daemon", "1"]),
    f.deps,
  );
  expect(f.launches).toHaveLength(1);
  expect(f.logs.at(-1)).toBe(join(options.batchDir, "daemon1", "env.sh"));
});
posixTest("tampered specs/default options are refused before a launch", async () => {
  const f = fixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  const path = join(options.batchDir, "batch.json");
  const manifest = JSON.parse(f.files.get(path)!);
  manifest.specs[0].env.AUTOMOBILE_DATA_DIR = "/home/fake/.auto-mobile";
  f.files.set(path, JSON.stringify(manifest));
  expect(
    await runPrivateDaemonCommand(parsed(["start", "--batch-dir", options.batchDir]), f.deps),
  ).toBe(2);
  expect(f.launches).toEqual([]);
});
