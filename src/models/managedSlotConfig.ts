import { z } from "zod/v4";
import { DEFAULT_SESSION_IDLE_TIMEOUT_MS } from "../daemon/sessionLivenessWindows";
import {
  androidProvisionDeviceSpecSchema,
  iosProvisionDeviceSpecSchema,
} from "../server/provisionDeviceSpecSchemas";
import { MAX_PROVISION_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { errorMessage } from "../utils/describeUnknownError";
import { ActionableError } from "./ActionableError";

/**
 * Launch-time, launcher-trusted configuration for managed device slots (epic #11172, #11173).
 *
 * Only the process that launches the stdio proxy sets it (`--managed-slot-config` or
 * `AUTOMOBILE_MANAGED_SLOT_CONFIG`); agent-facing tools cannot change it. There is deliberately
 * no operation identity: retries converge through the scoped slot identity and assignment
 * generation, and `executionAttempt` is correlation only, never authorization.
 */

/** Contract versions this build can serve. Rejected before any mutation when absent. */
export const MANAGED_SLOT_SUPPORTED_CONTRACT_VERSIONS: readonly number[] = [1];

/** Capability token the daemon advertises in `daemon/capabilities` for contract version 1. */
export const MANAGED_SLOTS_V1_CAPABILITY = "managed-slots/v1";

/** Key under `InitializeResult.capabilities.experimental` that carries the contract. */
export const MANAGED_SLOTS_EXPERIMENTAL_CAPABILITY = "automobile/managedSlots";

export const MANAGED_SLOT_CONFIG_FLAG = "--managed-slot-config";
export const MANAGED_SLOT_CONFIG_ENV = "AUTOMOBILE_MANAGED_SLOT_CONFIG";

/** Initial support is exactly one slot and one device per group. */
export const MAX_MANAGED_SLOT_GROUP_SIZE = 1;

/** The 2-minute default; a trusted config may lengthen but never shorten the idle window. */
export const MIN_MANAGED_SLOT_IDLE_TIMEOUT_MS = DEFAULT_SESSION_IDLE_TIMEOUT_MS;
export const MAX_MANAGED_SLOT_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export type ManagedSlotConfigErrorCode =
  | "managed_slot_config_invalid"
  | "contract_unsupported"
  | "managed_slot_group_unsupported";

/** Typed launch-config failure; always raised before any device or registry mutation. */
export class ManagedSlotConfigError extends ActionableError {
  constructor(
    public readonly code: ManagedSlotConfigErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ManagedSlotConfigError";
  }
}

const identitySchema = z.string().trim().min(1).max(256);

const slotRequestBase = {
  slotIndex: z.number().int().min(0),
  role: identitySchema,
  /** Non-authoritative: a prior assignment's stable id may be tried first, never trusted. */
  priorDeviceHint: z.object({ stableId: identitySchema }).strict().optional(),
};

export const managedSlotRequestSchema = z.discriminatedUnion("platform", [
  z
    .object({
      ...slotRequestBase,
      platform: z.literal("android"),
      requestedSpec: androidProvisionDeviceSpecSchema,
    })
    .strict(),
  z
    .object({
      ...slotRequestBase,
      platform: z.literal("ios"),
      requestedSpec: iosProvisionDeviceSpecSchema,
    })
    .strict(),
]);

export const managedSlotConfigSchema = z
  .object({
    contractVersion: z.literal(1),
    managedHostScope: identitySchema,
    runnerNamespace: identitySchema,
    runnerIncarnation: identitySchema,
    /** Correlation only, never authorization. */
    executionAttempt: identitySchema.optional(),
    /** How many slots this host-local runner may hold; V1 supports exactly one. */
    localSlotCapacity: z.number().int().min(1),
    requests: z.array(managedSlotRequestSchema).min(1),
    preparationTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_PROVISION_DEVICE_TIMEOUT_MS)
      .optional(),
    idleTimeoutMs: z
      .number()
      .int()
      .min(MIN_MANAGED_SLOT_IDLE_TIMEOUT_MS)
      .max(MAX_MANAGED_SLOT_IDLE_TIMEOUT_MS)
      .optional(),
  })
  .strict()
  .superRefine((config, context) => {
    const seen = new Set<number>();
    config.requests.forEach((request, index) => {
      if (seen.has(request.slotIndex)) {
        context.addIssue({
          code: "custom",
          message: `duplicate slotIndex ${request.slotIndex}`,
          path: ["requests", index, "slotIndex"],
        });
      }
      seen.add(request.slotIndex);
    });
  });

export type ManagedSlotRequest = z.infer<typeof managedSlotRequestSchema>;
export type ManagedSlotConfig = z.infer<typeof managedSlotConfigSchema>;

const contractVersionProbeSchema = z.object({ contractVersion: z.unknown() }).loose();

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}

/**
 * Rejects a contract version this build cannot serve. Runs before schema validation of any other
 * field so a newer contract's different shape reports `contract_unsupported`, not a schema error.
 */
export function assertManagedSlotContractSupported(
  contractVersion: unknown,
  supportedVersions: readonly number[] = MANAGED_SLOT_SUPPORTED_CONTRACT_VERSIONS,
): void {
  if (typeof contractVersion !== "number" || !supportedVersions.includes(contractVersion)) {
    throw new ManagedSlotConfigError(
      "contract_unsupported",
      `managed slot contractVersion ${JSON.stringify(contractVersion)} is not supported; ` +
        `supported versions: ${supportedVersions.join(", ")}`,
    );
  }
}

/** True when a daemon's `daemon/capabilities` list advertises managed slot contract v1. */
export function daemonSupportsManagedSlots(capabilities: readonly string[]): boolean {
  return capabilities.includes(MANAGED_SLOTS_V1_CAPABILITY);
}

/** Validates an already-decoded JSON value into a trusted {@link ManagedSlotConfig}. */
export function parseManagedSlotConfig(value: unknown): ManagedSlotConfig {
  const probe = contractVersionProbeSchema.safeParse(value);
  if (!probe.success) {
    throw new ManagedSlotConfigError(
      "managed_slot_config_invalid",
      "managed slot config must be a JSON object",
    );
  }
  assertManagedSlotContractSupported(probe.data.contractVersion);
  const parsed = managedSlotConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ManagedSlotConfigError("managed_slot_config_invalid", describeIssues(parsed.error));
  }
  const config = parsed.data;
  if (
    config.localSlotCapacity > MAX_MANAGED_SLOT_GROUP_SIZE ||
    config.requests.length > MAX_MANAGED_SLOT_GROUP_SIZE
  ) {
    throw new ManagedSlotConfigError(
      "managed_slot_group_unsupported",
      `managed slot groups larger than ${MAX_MANAGED_SLOT_GROUP_SIZE} slot/device are not supported ` +
        `(localSlotCapacity=${config.localSlotCapacity}, requests=${config.requests.length})`,
    );
  }
  return config;
}

/** Parses the flag/env value: a leading `{` is inline JSON, anything else is a file path. */
export function parseManagedSlotConfigSource(
  source: string,
  readFile: (path: string) => string,
): ManagedSlotConfig {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    throw new ManagedSlotConfigError(
      "managed_slot_config_invalid",
      "managed slot config value is empty; pass inline JSON or a file path",
    );
  }
  let text = trimmed;
  if (!trimmed.startsWith("{")) {
    try {
      text = readFile(trimmed);
    } catch (error) {
      throw new ManagedSlotConfigError(
        "managed_slot_config_invalid",
        `cannot read managed slot config file ${trimmed}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ManagedSlotConfigError(
      "managed_slot_config_invalid",
      `managed slot config is not valid JSON: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  return parseManagedSlotConfig(json);
}

export interface ManagedSlotConfigLaunch {
  /** Raw `--managed-slot-config` value, when the flag is present. */
  flagValue?: string;
  /** Raw `AUTOMOBILE_MANAGED_SLOT_CONFIG` value. */
  envValue?: string;
  readFile: (path: string) => string;
  /** The launch also asked for `--initial-session-uuid`, which is incompatible. */
  hasInitialSessionUuid?: boolean;
  /** The launch also asked for `--no-proxy`/`--direct`, which is incompatible. */
  noProxy?: boolean;
}

/** Resolves the launch config. The flag wins over the env; absent both returns undefined. */
export function resolveManagedSlotConfig(
  launch: ManagedSlotConfigLaunch,
): ManagedSlotConfig | undefined {
  const source = launch.flagValue ?? launch.envValue;
  if (source === undefined) {
    return undefined;
  }
  if (launch.hasInitialSessionUuid || launch.noProxy) {
    throw new ManagedSlotConfigError(
      "managed_slot_config_invalid",
      "managed slot config is incompatible with --initial-session-uuid and --no-proxy",
    );
  }
  return parseManagedSlotConfigSource(source, launch.readFile);
}
