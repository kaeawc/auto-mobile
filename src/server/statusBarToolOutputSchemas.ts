import { z } from "zod/v4";
import {
  STATUS_BAR_BATTERY_STATES,
  STATUS_BAR_DATA_NETWORKS,
} from "../features/utility/StatusBarOverride";

const statusBarFieldSchema = z.enum([
  "time",
  "batteryLevel",
  "batteryState",
  "cellularBars",
  "wifiBars",
  "dataNetwork",
  "operatorName",
  "hideNotifications",
]);

const statusBarOverridesSchema = z
  .object({
    time: z.string().optional(),
    batteryLevel: z.number().optional(),
    batteryState: z.enum(STATUS_BAR_BATTERY_STATES).optional(),
    cellularBars: z.number().optional(),
    wifiBars: z.number().optional(),
    dataNetwork: z.enum(STATUS_BAR_DATA_NETWORKS).optional(),
    operatorName: z.string().optional(),
    hideNotifications: z.boolean().optional(),
  })
  .passthrough();

/** Every statusBar outcome; `failed` is returned with `isError`. */
export const statusBarResultSchema = z
  .object({
    message: z.string(),
    success: z.boolean(),
    status: z.enum(["applied", "partial", "cleared", "current", "unsupported", "failed"]),
    action: z.enum(["override", "clear", "get"]),
    deviceId: z.string(),
    platform: z.string(),
    applied: z.array(statusBarFieldSchema).optional(),
    unsupported: z.array(statusBarFieldSchema).optional(),
    override: statusBarOverridesSchema.nullable().optional(),
    ownerSessionId: z.string().nullable().optional(),
    raw: z.string().nullable().optional(),
    error: z.string().optional(),
  })
  .passthrough();
