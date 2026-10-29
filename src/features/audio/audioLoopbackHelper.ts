import { existsSync } from "node:fs";
import { ENV, readEnvRaw } from "../../config/env";
import { DefaultHostCommandExecutor } from "../../utils/HostCommandExecutor";
import type { LoopbackHelperProcess } from "./loopbackHelperProcess";

/** The configured audio-loopback helper, when it exists on disk. */
export function audioLoopbackHelperPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = readEnvRaw(ENV.IOS_AUDIO_LOOPBACK_HELPER, env);
  return configured && existsSync(configured) ? configured : undefined;
}

export function spawnLoopbackHelper(helperPath: string, args: string[]): LoopbackHelperProcess {
  const child = new DefaultHostCommandExecutor().spawn(helperPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  // stdio is all "pipe", so the streams exist.
  return child as LoopbackHelperProcess;
}
