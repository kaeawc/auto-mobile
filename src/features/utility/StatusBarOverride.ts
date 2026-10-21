import type { ExecResult } from "../../models";
import { ActionableError } from "../../models/ActionableError";

/**
 * Deterministic status bar for screenshots and video (#14105): `simctl status_bar` on the iOS
 * Simulator and SystemUI demo mode on Android. Physical iOS has no override and is `unsupported`.
 */

export const STATUS_BAR_BATTERY_STATES = ["charging", "charged", "discharging"] as const;
export const STATUS_BAR_DATA_NETWORKS = ["wifi", "5g", "lte", "4g", "3g", "hide"] as const;

export type StatusBarBatteryState = (typeof STATUS_BAR_BATTERY_STATES)[number];
export type StatusBarDataNetwork = (typeof STATUS_BAR_DATA_NETWORKS)[number];

export interface StatusBarOverrides {
  time?: string;
  batteryLevel?: number;
  batteryState?: StatusBarBatteryState;
  cellularBars?: number;
  wifiBars?: number;
  dataNetwork?: StatusBarDataNetwork;
  operatorName?: string;
  hideNotifications?: boolean;
}

export type StatusBarField = keyof StatusBarOverrides;

export interface StatusBarApplyOutcome {
  /** Requested fields the platform applied. */
  applied: StatusBarField[];
  /** Requested fields the platform has no override for; they were skipped, not failed. */
  unsupported: StatusBarField[];
}

export interface StatusBarController {
  override(overrides: StatusBarOverrides, signal?: AbortSignal): Promise<StatusBarApplyOutcome>;
  clear(signal?: AbortSignal): Promise<void>;
  /** The platform's own readback of the override, when it has one. */
  read(signal?: AbortSignal): Promise<string | null>;
}

export const STATUS_BAR_COMMAND_TIMEOUT_MS = 10_000;

/** The fields a request set, in declaration order. */
export function requestedStatusBarFields(overrides: StatusBarOverrides): StatusBarField[] {
  const fields: StatusBarField[] = [
    "time",
    "batteryLevel",
    "batteryState",
    "cellularBars",
    "wifiBars",
    "dataNetwork",
    "operatorName",
    "hideNotifications",
  ];
  return fields.filter((field) => overrides[field] !== undefined);
}

export function throwOnExecError(result: ExecResult, command: string): void {
  if (result.error) {
    throw new ActionableError(`${command} failed: ${result.error}`);
  }
}
