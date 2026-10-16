import { z } from "zod";
import {
  parseSessionBrokerHostConfig,
  type SessionBrokerHostConfig,
} from "../../src/daemon/sessionBroker/hostConfig";
import { parseSessionConfig, type SessionConfig } from "../../src/devices/sessionConfig";
import type { IdGenerator } from "../../src/utils/IdGenerator";

const clientSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9-]{1,32}$/),
    platform: z.enum(["ios", "android"]),
    // Product parsers own the hardware, OS and timeout contracts.
    hardware: z.unknown().optional(),
    os: z.unknown().optional(),
    idleTimeoutMs: z.number().optional(),
    preparationTimeoutMs: z.number().optional(),
  })
  .strict();
const cap = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const batchSchema = z
  .object({
    schemaVersion: z.literal(1),
    limits: z.object({ totalDeviceCap: cap, sessionCap: cap, idlePoolCap: cap }).strict(),
    reuseCleanDevices: z.boolean(),
    defaults: z.object({ ios: z.unknown().optional(), android: z.unknown().optional() }).strict(),
    // Product host-config parser owns both shapes; the Android/iOS resolvers require them.
    androidProfileArchetypes: z.unknown().optional(),
    iosClassifications: z.unknown().optional(),
    clients: z.array(clientSchema),
  })
  .strict();

export type BrokerBatchClient = z.infer<typeof clientSchema>;
export type BrokerBatch = Omit<
  z.infer<typeof batchSchema>,
  "defaults" | "androidProfileArchetypes" | "iosClassifications"
> & {
  defaults: SessionBrokerHostConfig["defaults"];
  androidProfileArchetypes: SessionBrokerHostConfig["androidProfileArchetypes"];
  iosClassifications: SessionBrokerHostConfig["iosClassifications"];
};
export interface BrokerBatchOptions {
  maxDevices?: number;
  allowReuse?: boolean;
}

export function renderClientRequest(client: BrokerBatchClient, requestId: string): SessionConfig {
  const hardware =
    typeof client.hardware === "string"
      ? { kind: "archetype", archetype: client.hardware }
      : client.hardware === undefined
        ? { kind: "omitted" }
        : client.hardware;
  return parseSessionConfig({
    contractVersion: 1,
    requestId,
    device: {
      schemaVersion: 1,
      platform: client.platform,
      hardware,
      os: client.os === undefined ? { kind: "omitted" } : client.os,
    },
    ...(client.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: client.idleTimeoutMs }),
    ...(client.preparationTimeoutMs === undefined
      ? {}
      : { preparationTimeoutMs: client.preparationTimeoutMs }),
  });
}

export function renderHostConfig(
  batch: Pick<z.infer<typeof batchSchema>, "limits" | "defaults" | "reuseCleanDevices"> &
    Partial<Pick<z.infer<typeof batchSchema>, "androidProfileArchetypes" | "iosClassifications">>,
): SessionBrokerHostConfig {
  return parseSessionBrokerHostConfig({
    contractVersion: 1,
    limits: batch.limits,
    defaults: batch.defaults,
    // Undefined keys fall back to the product defaults ({} and []).
    androidProfileArchetypes: batch.androidProfileArchetypes,
    iosClassifications: batch.iosClassifications,
    reuseCleanDevices: batch.reuseCleanDevices,
  });
}

export function parseBrokerBatch(input: unknown, options: BrokerBatchOptions = {}): BrokerBatch {
  const batch = batchSchema.parse(input);
  const maxDevices = options.maxDevices ?? 2;
  if (!Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 4) {
    throw new Error("--max-devices must be an integer from 1 to the hard ceiling of 4.");
  }
  if (batch.limits.totalDeviceCap > maxDevices) {
    throw new Error(`totalDeviceCap exceeds --max-devices ${maxDevices} (hard ceiling 4).`);
  }
  if (!options.allowReuse && (batch.limits.idlePoolCap !== 0 || batch.reuseCleanDevices)) {
    throw new Error("idlePoolCap must be 0 and reuseCleanDevices false without --allow-reuse.");
  }
  if (new Set(batch.clients.map((client) => client.name)).size !== batch.clients.length) {
    throw new Error("Broker batch client names must be unique.");
  }
  const host = renderHostConfig(batch);
  for (const client of batch.clients) {
    renderClientRequest(client, `validate-${client.name}`);
    if (!host.defaults[client.platform]) {
      throw new Error(`Client ${client.name} requires explicit ${client.platform} defaults.`);
    }
  }
  return {
    ...batch,
    defaults: host.defaults,
    androidProfileArchetypes: host.androidProfileArchetypes,
    iosClassifications: host.iosClassifications,
  };
}

/** One injected batch identity, with explicit per-client attempt numbers. Persist before reuse. */
export class BrokerBatchRequestIds {
  readonly batchId: string;
  private readonly attempts = new Map<string, number>();

  constructor(ids: IdGenerator) {
    this.batchId = ids.next();
  }

  next(client: string): string {
    const attempt = (this.attempts.get(client) ?? 0) + 1;
    this.attempts.set(client, attempt);
    return `${this.batchId}-${client}-${attempt}`;
  }
}

export function planExpectations(batch: BrokerBatch): Array<{
  name: string;
  expected: "ready" | "failed:capacity_exhausted";
}> {
  return batch.clients.map((client, index) => ({
    name: client.name,
    expected:
      index < Math.min(batch.limits.totalDeviceCap, batch.limits.sessionCap)
        ? "ready"
        : "failed:capacity_exhausted",
  }));
}
