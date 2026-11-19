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
  /** True when argv was replaced by {@link REDACTED_COMMAND_ARG}. */
  redacted?: true;
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
