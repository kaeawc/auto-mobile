import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Resolve the local path to the built `automobile-video.jar` (the persistent
 * on-device encoder DEX). The persistent WebRTC source needs this to push and
 * launch the server; when it cannot be found the source is unavailable and the
 * stream manager falls back to segment-rotated `screenrecord`.
 *
 * Resolution order:
 * 1. `AUTOMOBILE_VIDEO_SERVER_JAR` env override (absolute path).
 * 2. The Gradle build output under the repo (`android/video-server/build/libs`).
 */
export const VIDEO_SERVER_JAR_ENV = "AUTOMOBILE_VIDEO_SERVER_JAR";

export function resolveVideoServerJarPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): string | null {
  const override = env[VIDEO_SERVER_JAR_ENV];
  if (override && existsSync(override)) {
    return override;
  }

  const built = path.resolve(
    cwd,
    "android",
    "video-server",
    "build",
    "libs",
    "automobile-video.jar"
  );
  if (existsSync(built)) {
    return built;
  }

  return null;
}
