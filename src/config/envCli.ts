/**
 * Registry entries for the variables the CLI argument parser reads (#11848). Kept beside
 * `env.ts` (which re-exports them and folds them into `ENV_REGISTRY`) so that file does not
 * outgrow its size budget. Resolution stays at the call site in `src/cli/parseArgs.ts`.
 */
import type { EnvVarSpec } from "./env";

/** Retired per-toolset variables: any variable with this prefix is rejected at startup. */
export const RETIRED_TOOLSET_ENV_PREFIX = "AUTOMOBILE_TOOLSET_";

export const CLI_ENV = {
  SESSION_CONFIG: {
    name: "AUTOMOBILE_SESSION_CONFIG",
    kind: "path",
    default: "unset",
    doc: "Session configuration file read by the CLI, equivalent to --session-config.",
  },
  DEBUG: {
    name: "AUTOMOBILE_DEBUG",
    kind: "string",
    default: "off",
    doc: "Enable CLI debug logging; exact 1 enables (also --debug).",
  },
  DEBUG_PERF: {
    name: "AUTOMOBILE_DEBUG_PERF",
    kind: "string",
    default: "off",
    doc: "Enable UI performance debug tracking; exact 1 enables (also --debug-perf).",
  },
  VIDEO_QUALITY_PRESET: {
    name: "AUTOMOBILE_VIDEO_QUALITY_PRESET",
    legacyName: "AUTO_MOBILE_VIDEO_QUALITY_PRESET",
    kind: "string",
    default: "unset",
    doc: "Default video quality preset; exact low, medium or high.",
  },
  VIDEO_TARGET_BITRATE_KBPS: {
    name: "AUTOMOBILE_VIDEO_TARGET_BITRATE_KBPS",
    legacyName: "AUTO_MOBILE_VIDEO_TARGET_BITRATE_KBPS",
    kind: "string",
    default: "unset",
    doc: "Default video target bitrate in kbps; positive base-10 integer.",
  },
  VIDEO_MAX_THROUGHPUT_MBPS: {
    name: "AUTOMOBILE_VIDEO_MAX_THROUGHPUT_MBPS",
    legacyName: "AUTO_MOBILE_VIDEO_MAX_THROUGHPUT_MBPS",
    kind: "string",
    default: "unset",
    doc: "Default video max throughput in Mbps; positive finite number.",
  },
  VIDEO_FPS: {
    name: "AUTOMOBILE_VIDEO_FPS",
    legacyName: "AUTO_MOBILE_VIDEO_FPS",
    kind: "string",
    default: "unset",
    doc: "Default video frame rate; positive base-10 integer.",
  },
  VIDEO_MAX_ARCHIVE_MB: {
    name: "AUTOMOBILE_VIDEO_MAX_ARCHIVE_MB",
    legacyName: "AUTO_MOBILE_VIDEO_MAX_ARCHIVE_MB",
    kind: "string",
    default: "unset",
    doc: "Default video archive size cap in MB; positive finite number.",
  },
  VIDEO_FORMAT: {
    name: "AUTOMOBILE_VIDEO_FORMAT",
    legacyName: "AUTO_MOBILE_VIDEO_FORMAT",
    kind: "string",
    default: "unset",
    doc: "Default video container format; exact mp4.",
  },
} as const satisfies Record<string, EnvVarSpec>;
