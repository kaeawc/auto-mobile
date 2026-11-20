import type { BootedDevice } from "../../models";

/**
 * On-disk format of a fixture capture (#18770). One directory per tool call holds
 * {@link CAPTURE_PROVENANCE_FILE} and {@link CAPTURE_COMMANDS_FILE}. The promote step
 * (`scripts/fixtures/promote-capture.ts`) reads this format, so a change here is a
 * format change: bump {@link FIXTURE_CAPTURE_SCHEMA_VERSION}.
 */
export const FIXTURE_CAPTURE_SCHEMA_VERSION = 1;
export const CAPTURE_PROVENANCE_FILE = "provenance.json";
export const CAPTURE_COMMANDS_FILE = "commands.json";

/** Recorded in place of argv for a command whose input must never be logged (password typing). */
export const REDACTED_COMMAND_ARG = "<redacted:password-field>";

/** Most characters kept from one command's stdout or stderr (1 MiB, node's default maxBuffer). */
export const MAX_CAPTURED_STREAM_CHARS = 1024 * 1024;
/** Most stdout plus stderr characters kept across all commands of one tool call (8 MiB). */
export const MAX_CAPTURED_CALL_CHARS = 8 * 1024 * 1024;
/** Appended to a stream cut by either limit; the command is also marked `truncated: true`. */
export const TRUNCATED_OUTPUT_MARKER = "<truncated:fixture-capture-limit>";

/** What the capturing daemon's own dirty-state probe found; only `clean` can be promoted. */
export type CaptureSourceTreeState = "clean" | "dirty" | "unknown";

/** The device fields a capture records; the device id is redacted only on promotion. */
export type CapturedDevice = Pick<
  BootedDevice,
  | "platform"
  | "deviceId"
  | "name"
  | "model"
  | "deviceType"
  | "formFactor"
  | "osVersion"
  | "apiLevel"
  | "iosVersion"
  | "runtimeId"
  | "runtime"
>;

export interface CaptureProvenance {
  schemaVersion: typeof FIXTURE_CAPTURE_SCHEMA_VERSION;
  tool: { name: string };
  /** ISO-8601 UTC time the tool call started. */
  captureDate: string;
  /** The MCP server version; source checkouts carry the commit as `+g<sha>[.dirty]`. */
  automobileVersion: string;
  /** The settled working-tree state behind `automobileVersion`. */
  sourceTreeState: CaptureSourceTreeState;
  /** Absent when the tool ran without resolving a device. */
  device?: CapturedDevice;
}

export interface CapturedCommand {
  /** 0-based order within the tool call. */
  index: number;
  argv: string[];
  cwd?: string;
  /** Process exit code; null when the process never exited normally (spawn error or signal). */
  exitCode: number | null;
  signal?: string;
  /** Node's error code for a command that failed to start (`ENOENT`, `ETIMEDOUT`). */
  errorCode?: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  /**
   * True when argv was replaced by {@link REDACTED_COMMAND_ARG}, or when a secret the caller
   * keeps out of logs was scrubbed from argv or output.
   */
  redacted?: true;
  /** True when stdout or stderr was cut at a capture limit and ends in the truncation marker. */
  truncated?: true;
}

/** Everything one tool call captured, as the writer receives it. */
export interface ToolCallCapture {
  provenance: CaptureProvenance;
  commands: CapturedCommand[];
}

export function capturedDeviceOf(device: BootedDevice): CapturedDevice {
  const fields: CapturedDevice = {
    platform: device.platform,
    deviceId: device.deviceId,
    name: device.name,
    model: device.model,
    deviceType: device.deviceType,
    formFactor: device.formFactor,
    osVersion: device.osVersion,
    apiLevel: device.apiLevel,
    iosVersion: device.iosVersion,
    runtimeId: device.runtimeId,
    runtime: device.runtime,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as CapturedDevice;
}
