import { existsSync } from "node:fs";
import { ActionableError } from "../../models/ActionableError";

/** Absolute path to a locally built `screen-capture-helper`, for development. */
export const IOS_SCREEN_CAPTURE_HELPER_ENV = "AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER";
/** Legacy spelling of {@link IOS_SCREEN_CAPTURE_HELPER_ENV}, still honored. */
export const IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS = "AUTO_MOBILE_IOS_SCREEN_CAPTURE_HELPER";

export interface IosScreenCaptureHelperPathResolverOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
}

/**
 * The developer's helper-binary override, under either env spelling. Daemon
 * startup skips the release prefetch when this is set, so every consumer of the
 * helper has to consult it before falling back to the pinned release asset.
 */
export function readScreenCaptureHelperEnvOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[IOS_SCREEN_CAPTURE_HELPER_ENV] ?? env[IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS];
}

/**
 * Resolve an explicitly configured helper path, falling back to the env
 * override. Throws when no candidate exists on disk — callers that also accept
 * the released helper should try {@link ScreenCaptureHelperProvider} instead of
 * treating this as the only source.
 */
export function resolveIosScreenCaptureHelperPath(
  explicitPath?: string,
  options: IosScreenCaptureHelperPathResolverOptions = {},
): string {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const candidates = [explicitPath, readScreenCaptureHelperEnvOverride(env)].filter(
    (candidate): candidate is string => Boolean(candidate),
  );

  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }

  throw new ActionableError(
    `No executable screen-capture-helper was found at the configured path. Set ${IOS_SCREEN_CAPTURE_HELPER_ENV} to the absolute path of a local development build.`,
  );
}
