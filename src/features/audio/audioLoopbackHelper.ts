import { existsSync } from "node:fs";
import { ENV, readEnvRaw } from "../../config/env";
import { DefaultHostCommandExecutor } from "../../utils/HostCommandExecutor";
import { AudioLoopbackHelperProvider } from "./AudioLoopbackHelperProvider";
import { logger } from "../../utils/logger";
import type { LoopbackHelperProcess } from "./loopbackHelperProcess";

export interface AudioLoopbackHelperResolutionDeps {
  provider?: Pick<AudioLoopbackHelperProvider, "ensure">;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

/** Prefer an explicit local helper; otherwise resolve the verified macOS release. */
export async function audioLoopbackHelperPath(
  env: NodeJS.ProcessEnv = process.env,
  deps: AudioLoopbackHelperResolutionDeps = {},
): Promise<string | undefined> {
  const configured = readEnvRaw(ENV.IOS_AUDIO_LOOPBACK_HELPER, env);
  if (configured !== undefined) {
    return configured && (deps.exists ?? existsSync)(configured) ? configured : undefined;
  }
  if ((deps.platform ?? process.platform) !== "darwin") {
    return undefined;
  }
  try {
    const provider = deps.provider ?? AudioLoopbackHelperProvider.getInstance();
    return (await provider.ensure()) ?? undefined;
  } catch (error) {
    logger.warn("Unable to resolve the released audio-loopback helper", error);
    return undefined;
  }
}

export function spawnLoopbackHelper(helperPath: string, args: string[]): LoopbackHelperProcess {
  const child = new DefaultHostCommandExecutor().spawn(helperPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  // stdio is all "pipe", so the streams exist.
  return child as LoopbackHelperProcess;
}
