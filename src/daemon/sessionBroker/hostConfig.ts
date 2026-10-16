import { ENV as ENV_SPECS } from "../../config/env";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { SlotScopeIdentity } from "../managedSlots/slotRegistry";

/** Operator configuration, never a session requester input. */
export const SESSION_BROKER_HOST_CONFIG_ENV = ENV_SPECS.SESSION_BROKER_CONFIG.name;
export const SESSION_BROKER_CAPABILITY = "session-broker/v1";

/** One private allocation scope in the host-wide registry; no caller chooses these values. */
export const SESSION_BROKER_SCOPE: SlotScopeIdentity = {
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

const hostConfig = z
  .object({
    contractVersion: z.literal(1),
    limits: z
      .object({
        totalDeviceCap: cap.optional(),
        sessionCap: cap.optional(),
        idlePoolCap: cap.optional(),
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
  })
  .strict()
  .refine((config) => config.defaults.ios !== undefined || config.defaults.android !== undefined, {
    message: "At least one platform must have an explicit default policy",
  });

export type SessionBrokerHostConfig = z.infer<typeof hostConfig>;

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
