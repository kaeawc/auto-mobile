#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { z } from "zod";
import {
  privateClientEnvironment,
  canonicalizeHostPath,
  type HostDefaults,
} from "../privateDaemonEnv";
import { privateHarnessEnvRefusal } from "../harnessEnv";
import { deviceStartGuardRefusal } from "../deviceStartGuard";
import { isProcessRunning } from "../../../src/utils/processLiveness";
import { errorMessage } from "../../../src/utils/describeUnknownError";

export interface HarnessGuardDeps {
  env: Record<string, string | undefined>;
  host: HostDefaults;
  runtimePath: string;
  readFile(path: string): string;
  isPidAlive(pid: number): boolean;
}
export type HarnessGuardResult = { ok: true; stdout: string } | { ok: false; message: string };
const inputSchema = z
  .object({
    calls: z.array(z.object({ tool: z.string().min(1), arguments: z.unknown() }).strict()),
    allowSelector: z.boolean(),
  })
  .strict();
const pidSchema = z.object({ pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const daemonRefusal =
  "Run private-daemon.ts start first; a Python stdio client must not wake a dead daemon.";

export function runHarnessGuard(
  command: string | undefined,
  stdinText: string,
  deps: HarnessGuardDeps,
): HarnessGuardResult {
  try {
    if (command !== "resolve" && command !== "check-calls") {
      return { ok: false, message: "Expected resolve or check-calls." };
    }
    const input = inputSchema.parse(JSON.parse(stdinText));
    const env = privateClientEnvironment(deps.env, {});
    if (command === "resolve") {
      // Inspect inherited overrides before the shared client sanitizer removes them.
      const refusal =
        privateHarnessEnvRefusal(deps.env, deps.host) ?? privateHarnessEnvRefusal(env, deps.host);
      if (refusal) {
        return { ok: false, message: refusal };
      }
      const pidText = deps.readFile(env.AUTOMOBILE_DAEMON_PID_FILE_PATH);
      const parsedPid = pidSchema.safeParse(JSON.parse(pidText));
      if (!parsedPid.success || !deps.isPidAlive(parsedPid.data.pid)) {
        return { ok: false, message: daemonRefusal };
      }
      for (const key of ["MT_DAEMON", "MT_PORT"]) {
        if (!env[key]?.trim()) {
          return { ok: false, message: `Private harness env requires ${key}.` };
        }
      }
    }
    for (const [index, call] of input.calls.entries()) {
      const refusal = deviceStartGuardRefusal(call.tool, call.arguments, input);
      if (refusal) {
        return { ok: false, message: `calls[${index}]: ${refusal}` };
      }
    }
    return {
      ok: true,
      stdout: JSON.stringify(
        command === "check-calls"
          ? { ok: true }
          : {
              command: deps.runtimePath,
              args: [env.MT_SERVER],
              env,
              daemon: {
                name: env.MT_DAEMON,
                port: env.MT_PORT,
                socketPath: env.AUTOMOBILE_DAEMON_SOCKET_PATH,
                pidFilePath: env.AUTOMOBILE_DAEMON_PID_FILE_PATH,
              },
            },
      ),
    };
  } catch (error) {
    // The CLI boundary reports this typed refusal on stderr before spawning anything.
    return {
      ok: false,
      message: `${daemonRefusal} Guard input/read failed: ${errorMessage(error)}`,
    };
  }
}
export async function main(): Promise<number> {
  const result = runHarnessGuard(
    process.argv.length === 3 ? process.argv[2] : undefined,
    await Bun.stdin.text(),
    {
      env: process.env,
      host: {
        homeDirs: [homedir(), userInfo().homedir],
        uid: process.getuid?.() ?? userInfo().username,
        canonicalize: canonicalizeHostPath,
      },
      runtimePath: process.execPath,
      readFile: (path) => readFileSync(path, "utf8"),
      isPidAlive: isProcessRunning,
    },
  );
  if (!result.ok) {
    console.error(result.message);
    return 2;
  }
  console.log(result.stdout);
  return 0;
}
if (import.meta.main) {
  process.exitCode = await main();
}
