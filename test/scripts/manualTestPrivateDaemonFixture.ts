import { resolve } from "node:path";
import {
  parsePrivateDaemonArgs,
  type PrivateDaemonCliDeps,
  type PrivateDaemonCommand,
} from "../../scripts/manual-test/private-daemon";
import type { PrivateDaemonBatchOptions } from "../../scripts/manual-test/privateDaemonEnv";
import { FakeTimer } from "../fakes/FakeTimer";
export const options: PrivateDaemonBatchOptions = {
  batchDir: resolve("/mt-batch"),
  count: 2,
  basePort: 3160,
  auxRoot: resolve("/mt-aux"),
  serverPath: resolve("/built/index.js"),
};
export function parsed(args: string[]): PrivateDaemonCommand {
  const result = parsePrivateDaemonArgs(args);
  if ("help" in result) {
    throw new Error("Unexpected help");
  }
  if ("error" in result) {
    throw new Error(result.error);
  }
  return result;
}
export function fixture() {
  const files = new Map<string, string>();
  const writes: string[] = [],
    dirs: Array<[string, number]> = [],
    logs: string[] = [];
  const removes: string[] = [],
    modes: Array<[string, number]> = [],
    captures: Array<{
      command: string;
      args: string[];
      env: Record<string, string>;
      timeoutMs: number;
    }> = [];
  const launches: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
  const deps: PrivateDaemonCliDeps = {
    timer: new FakeTimer(),
    hostStats: () => ({
      platform: "linux",
      loadAverage: [0, 0, 0],
      cpuCount: 8,
      freeMemoryBytes: 1024,
      totalMemoryBytes: 2048,
    }),
    bootLock: { tryAcquire: () => true, release: () => {} },
    signalPid: () => {
      throw new Error("Unexpected signal");
    },
    requestSocket: async () => {
      throw new Error("socket unavailable");
    },
    runtimePath: resolve("/fake/runtime"),
    repoRoot: resolve("/fake/repo"),
    removeFile: (path) => {
      removes.push(path);
      files.delete(path);
    },
    chmod: (path, mode) => {
      modes.push([path, mode]);
    },
    runCapture: async (command, args, env, timeoutMs) => {
      captures.push({ command, args, env, timeoutMs });
      return {
        exitCode: 0,
        stdout: '{"devices":{"runtime":[{"udid":"sim1","name":"fake","state":"Booted"}]}}',
        stderr: "",
      };
    },
    probeSocket: async () => ({ alive: false, reason: "not running" }),
    queryAdbHost: async () => {
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    },
    host: { homeDirs: [resolve("/home/fake")], uid: 4242, canonicalize: resolve },
    env: {
      AUTOMOBILE_MANAGED_SLOT_CONFIG: "inherited",
      AUTOMOBILE_MANAGED_SLOT_MAX_DEVICES: "999",
      AUTOMOBILE_SESSION_BROKER_CONFIG: "/inherited/broker.json",
      AUTOMOBILE_SESSION_CONFIG: "/inherited/session.json",
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
  return { files, writes, dirs, logs, launches, removes, modes, captures, deps };
}
