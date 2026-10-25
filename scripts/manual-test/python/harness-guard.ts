#!/usr/bin/env bun
import "../harnessLogSink";
import { harnessChildEnvironment } from "../harnessLogSink";
import { probeControlSocket } from "../controlSocketProbe";
import { connectFrameSocket } from "../daemon-frame";
import { defaultTimer } from "../../../src/utils/SystemTimer";
import { defaultIdGenerator } from "../../../src/utils/IdGenerator";
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
import { DEFAULT_DAEMON_PORT } from "../../../src/daemon/wire/constants";
import { errorMessage } from "../../../src/utils/describeUnknownError";

export interface HarnessGuardDeps {
  env: Record<string, string | undefined>;
  host: HostDefaults;
  runtimePath: string;
  readFile(path: string): string;
  isPidAlive(pid: number): boolean;
  probeDaemonSocket(socketPath: string): Promise<{ alive: boolean; reason?: string }>;
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

export async function runHarnessGuard(
  command: string | undefined,
  stdinText: string,
  deps: HarnessGuardDeps,
): Promise<HarnessGuardResult> {
  try {
    if (command !== "resolve" && command !== "check-calls") {
      return { ok: false, message: "Expected resolve or check-calls." };
    }
    let input: z.infer<typeof inputSchema>;
    try {
      input = inputSchema.parse(JSON.parse(stdinText));
    } catch (error) {
      // Convert invalid input into the CLI's typed usage refusal.
      return { ok: false, message: `Invalid guard input: ${errorMessage(error)}` };
    }
    // Share the launcher scrub list for broker/session config and legacy slot variables.
    const env = privateClientEnvironment(deps.env, {});
    if (command === "resolve") {
      // Inspect inherited overrides before the shared client sanitizer removes them.
      const refusal =
        privateHarnessEnvRefusal(deps.env, deps.host) ?? privateHarnessEnvRefusal(env, deps.host);
      if (refusal) {
        return { ok: false, message: refusal };
      }
      const port = env.MT_PORT;
      if (
        !port ||
        !/^[0-9]+$/.test(port) ||
        Number(port) < 1 ||
        Number(port) > 65535 ||
        Number(port) === DEFAULT_DAEMON_PORT
      ) {
        return {
          ok: false,
          message: `MT_PORT must be a decimal integer in 1..65535 away from resident default port ${DEFAULT_DAEMON_PORT}.`,
        };
      }
      if (!env.MT_DAEMON?.trim()) {
        return { ok: false, message: "Private harness env requires MT_DAEMON." };
      }
      let pid: number;
      try {
        const parsedPid = pidSchema.safeParse(
          JSON.parse(deps.readFile(env.AUTOMOBILE_DAEMON_PID_FILE_PATH)),
        );
        if (!parsedPid.success) {
          return { ok: false, message: daemonRefusal };
        }
        pid = parsedPid.data.pid;
      } catch {
        // File read/parse failures deliberately reveal only the start-first refusal.
        return { ok: false, message: daemonRefusal };
      }
      if (!deps.isPidAlive(pid)) {
        return { ok: false, message: daemonRefusal };
      }
      const probe = await deps.probeDaemonSocket(env.AUTOMOBILE_DAEMON_SOCKET_PATH);
      if (!probe.alive) {
        return {
          ok: false,
          message: `${daemonRefusal} ${probe.reason ?? "Control socket did not answer."}`,
        };
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
      message: `Guard failed: ${errorMessage(error)}`,
    };
  }
}
export async function main(): Promise<number> {
  const result = await runHarnessGuard(
    process.argv.length === 3 ? process.argv[2] : undefined,
    await Bun.stdin.text(),
    {
      env: harnessChildEnvironment(process.env),
      host: {
        homeDirs: [homedir(), userInfo().homedir],
        uid: process.getuid?.() ?? userInfo().username,
        canonicalize: canonicalizeHostPath,
      },
      runtimePath: process.execPath,
      readFile: (path) => readFileSync(path, "utf8"),
      isPidAlive: isProcessRunning,
      probeDaemonSocket: (path) =>
        probeControlSocket(path, {
          connect: connectFrameSocket,
          timer: defaultTimer,
          ids: defaultIdGenerator,
        }),
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
