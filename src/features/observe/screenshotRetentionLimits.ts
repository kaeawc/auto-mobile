import { ENV, readEnvNumber } from "../../config/env";
import type { EnvVarSpec } from "../../config/envSpec";
import { logger } from "../../utils/logger";
import {
  DEFAULT_SCREENSHOT_RETENTION_LIMITS,
  type ScreenshotRetentionLimits,
} from "./screenshotCacheEviction";

function readLimit(spec: EnvVarSpec, env: NodeJS.ProcessEnv, fallback: number): number {
  const invalid = (raw: string) =>
    logger.warn(`Ignoring invalid ${spec.name} value "${raw}"; using ${fallback}`);
  const value = readEnvNumber(spec, env, invalid);
  if (value === undefined) {
    return fallback;
  }
  if (spec.kind === "int" && !Number.isSafeInteger(value)) {
    invalid(String(value));
    return fallback;
  }
  // Byte capacities must also remain finite after converting MiB to bytes.
  if (spec.kind === "number" && !Number.isFinite(value * 1024 * 1024)) {
    invalid(String(value));
    return fallback;
  }
  return value;
}

/** Read process defaults once for the singleton; callers may inject an environment in tests. */
export function readScreenshotRetentionLimits(
  env: NodeJS.ProcessEnv = process.env,
): ScreenshotRetentionLimits {
  const defaults = DEFAULT_SCREENSHOT_RETENTION_LIMITS;
  const MiB = 1024 * 1024;
  return {
    baseBytes: readLimit(ENV.SCREENSHOT_CACHE_MB, env, defaults.baseBytes / MiB) * MiB,
    perDeviceBytes:
      readLimit(ENV.SCREENSHOT_CACHE_PER_DEVICE_MB, env, defaults.perDeviceBytes / MiB) * MiB,
    ceilingBytes:
      readLimit(ENV.SCREENSHOT_CACHE_CEILING_MB, env, defaults.ceilingBytes / MiB) * MiB,
    keepPerDevice: readLimit(ENV.SCREENSHOT_KEEP_PER_DEVICE, env, defaults.keepPerDevice),
  };
}
