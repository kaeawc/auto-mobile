import { ENV as ENV_SPECS } from "../../config/env";
import { readFile } from "node:fs/promises";
import { MAX_SETTIMEOUT_DELAY_MS } from "../../utils/SystemTimer";
import { z } from "zod";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BindingScopeIdentity } from "./registry/bindingRegistry";

/** Operator configuration, never a session requester input. */
export const SESSION_BROKER_HOST_CONFIG_ENV = ENV_SPECS.SESSION_BROKER_CONFIG.name;
export const SESSION_BROKER_EXPORT_CAPABILITY = "session-broker-export/v1";
export const SESSION_BROKER_CAPABILITY = "session-broker/v1";

/** One private allocation scope in the host-wide registry; no caller chooses these values. */
export const SESSION_BROKER_SCOPE: BindingScopeIdentity = {
  managedHostScope: "auto-mobile-host",
  runnerNamespace: "session-broker",
  runnerIncarnation: "private-pool-v1",
};

const modelType = z.discriminatedUnion("family", [
  z
    .object({ family: z.literal("iphone"), variant: z.enum(["standard", "pro", "pro-max", "air"]) })
    .strict(),
  z
    .object({
      family: z.literal("ipad"),
      variant: z.enum(["standard", "mini", "air", "pro"]),
      sizeInches: z
        .string()
        .regex(/^\d+(?:\.\d+)?$/)
        .optional(),
    })
    .strict(),
  z.object({ family: z.literal("duo"), variant: z.literal("duo") }).strict(),
]);
const modelReference = z
  .object({
    namespace: z.enum(["product-model", "simulator-device-type", "alias"]),
    value: z.string().min(1),
  })
  .strict();
const archetype = z.enum(["phone", "tablet", "duo"]);
const androidArchetype = z.enum(["phone", "tablet"]);
const version = z.string().regex(/^\d+(?:\.\d+)*$/);
const osSelector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), version }).strict(),
  z
    .object({
      kind: z.literal("major"),
      major: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ kind: z.literal("minimum"), version }).strict(),
]);
const osDefaults = z.object({ selector: osSelector, preferredVersion: version }).strict();
const iosDefaults = z
  .object({
    platform: z.literal("ios"),
    policyVersion: z.string().min(1),
    hardware: z
      .object({
        omitted: archetype,
        archetypes: z.array(z.object({ archetype, modelType }).strict()),
        modelTypes: z.array(z.object({ modelType, model: modelReference }).strict()),
      })
      .strict(),
    os: osDefaults,
  })
  .strict();
const androidDefaults = z
  .object({
    platform: z.literal("android"),
    policyVersion: z.string().min(1),
    hardware: z
      .object({
        omitted: androidArchetype,
        profiles: z.array(
          z.object({ archetype: androidArchetype, profileId: z.string().min(1) }).strict(),
        ),
      })
      .strict(),
    os: osDefaults,
  })
  .strict();
const cap = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Keep-booted cleaning cannot revert everything, so every Nth release erases instead (#15017). */
export const DEFAULT_IOS_KEEP_BOOTED_MAX_USES = 10;
const iosReuse = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }).strict(),
  z
    .object({
      mode: z.literal("erase"),
      maxUses: cap.positive().default(20),
      fallback: z.literal("erase").default("erase"),
    })
    .strict(),
  z
    .object({
      mode: z.literal("keep-booted"),
      maxUses: cap.positive().default(DEFAULT_IOS_KEEP_BOOTED_MAX_USES),
      fallback: z.literal("erase").default("erase"),
    })
    .strict(),
]);

const hostConfig = z
  .object({
    contractVersion: z.literal(1),
    limits: z
      .object({
        totalDeviceCap: cap.optional(),
        sessionCap: cap.optional(),
        idlePoolCap: cap.optional(),
        maxConcurrentResetBoots: cap.positive().optional(),
      })
      .strict(),
    defaults: z
      .object({ ios: iosDefaults.optional(), android: androidDefaults.optional() })
      .strict(),
    androidProfileArchetypes: z.record(z.string(), androidArchetype).default({}),
    iosClassifications: z
      .array(
        z
          .object({
            simulatorDeviceTypeIdentifier: z.string().min(1),
            modelType,
            aliases: z.array(z.string().min(1)).optional(),
          })
          .strict(),
      )
      .default([]),
    reuseCleanDevices: z.boolean().default(false),
    reuseAndroidCleanDevices: z.boolean().default(false),
    androidResetMode: z.enum(["snapshot", "keep-booted"]).optional(),
    androidResetTimeoutMs: z.number().int().positive().max(MAX_SETTIMEOUT_DELAY_MS).optional(),
    androidKeepBootedMaxUses: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    androidKeepBootedFallback: z.enum(["snapshot", "destroy"]).optional(),
    reuse: z.object({ ios: iosReuse }).strict().optional(),
  })
  .strict()
  .refine((config) => config.defaults.ios !== undefined || config.defaults.android !== undefined, {
    message: "At least one platform must have an explicit default policy",
  })
  .refine(
    (config) =>
      config.androidResetMode === undefined ||
      (config.reuseAndroidCleanDevices && config.defaults.android !== undefined),
    {
      message: "Android reset mode requires Android defaults and reuseAndroidCleanDevices",
    },
  )
  .refine(
    (config) =>
      (config.androidKeepBootedMaxUses === undefined &&
        config.androidKeepBootedFallback === undefined) ||
      config.androidResetMode === "keep-booted",
    { message: "Android keep-booted keys require keep-booted mode" },
  )
  .refine(
    (config) =>
      config.androidResetTimeoutMs === undefined ||
      config.androidResetMode === "snapshot" ||
      (config.androidResetMode === "keep-booted" &&
        config.androidKeepBootedFallback === "snapshot"),
    {
      path: ["androidResetTimeoutMs"],
      message: "androidResetTimeoutMs requires snapshot mode or keep-booted snapshot fallback",
    },
  )
  .refine(
    (config) => !config.reuseCleanDevices || !config.reuse || config.reuse.ios.mode === "erase",
    {
      message: "reuseCleanDevices: true selects iOS erase; remove it to select keep-booted or off",
    },
  )
  .refine(
    (config) =>
      config.defaults.ios !== undefined || !config.reuse || config.reuse.ios.mode === "off",
    { message: "iOS reuse requires an explicit defaults.ios policy" },
  );

export type SessionBrokerHostConfig = z.infer<typeof hostConfig>;

export function iosReusePolicy(config: SessionBrokerHostConfig): z.infer<typeof iosReuse> {
  if (!config.defaults.ios) {
    return { mode: "off" };
  }
  return (
    config.reuse?.ios ??
    (config.reuseCleanDevices ? { mode: "erase", maxUses: 20, fallback: "erase" } : { mode: "off" })
  );
}

export function parseSessionBrokerHostConfig(value: unknown): SessionBrokerHostConfig {
  const parsed = hostConfig.safeParse(value);
  if (!parsed.success) {
    throw new ActionableError(`Invalid session broker host configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

export async function readSessionBrokerHostConfig(path: string): Promise<SessionBrokerHostConfig> {
  try {
    return parseSessionBrokerHostConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw toActionableError(error, `Cannot load session broker host configuration at ${path}`);
  }
}
