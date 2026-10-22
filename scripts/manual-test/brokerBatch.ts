import { z } from "zod";
import {
  parseSessionBrokerHostConfig,
  iosReusePolicy,
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
/**
 * The batch envelope is only `schemaVersion` + `clients`; every other key is a host-config key
 * and is validated by the product parser, so a host-config key can never be accepted by the broker
 * and rejected here.
 */
const envelopeSchema = z
  .object({ schemaVersion: z.literal(1), clients: z.array(clientSchema) })
  .passthrough();

type HostConfig = SessionBrokerHostConfig;
type HostLimits = HostConfig["limits"];
type RequiredCaps = { totalDeviceCap: number; sessionCap: number; idlePoolCap: number };
export type BrokerBatchClient = z.infer<typeof clientSchema>;
export type BrokerBatch = Omit<HostConfig, "contractVersion" | "limits"> & {
  schemaVersion: 1;
  limits: HostLimits & RequiredCaps;
  clients: BrokerBatchClient[];
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

function parseHostKeys(raw: Record<string, unknown>): SessionBrokerHostConfig {
  // Drop the batch envelope; everything else is the host config, whatever keys the product adds.
  const { schemaVersion: _schemaVersion, clients: _clients, ...hostKeys } = raw;
  return parseSessionBrokerHostConfig({ ...hostKeys, contractVersion: 1 });
}

export function renderHostConfig(batch: Omit<BrokerBatch, "clients">): SessionBrokerHostConfig {
  return parseHostKeys(batch);
}

export function parseBrokerBatch(input: unknown, options: BrokerBatchOptions = {}): BrokerBatch {
  const envelope = envelopeSchema.parse(input);
  const { clients } = envelope;
  const host = parseHostKeys(envelope);
  const { totalDeviceCap, sessionCap, idlePoolCap } = host.limits;
  if (totalDeviceCap === undefined || sessionCap === undefined || idlePoolCap === undefined) {
    throw new Error(
      "limits.totalDeviceCap, limits.sessionCap and limits.idlePoolCap are required.",
    );
  }
  const { contractVersion: _contractVersion, ...hostRest } = host;
  const batch: BrokerBatch = {
    ...hostRest,
    schemaVersion: 1,
    limits: { ...host.limits, totalDeviceCap, sessionCap, idlePoolCap },
    clients,
  };
  const maxDevices = options.maxDevices ?? 2;
  if (!Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 4) {
    throw new Error("--max-devices must be an integer from 1 to the hard ceiling of 4.");
  }
  if (batch.limits.totalDeviceCap > maxDevices) {
    throw new Error(`totalDeviceCap exceeds --max-devices ${maxDevices} (hard ceiling 4).`);
  }
  if (
    !options.allowReuse &&
    (batch.limits.idlePoolCap !== 0 ||
      batch.reuseCleanDevices ||
      iosReusePolicy(host).mode !== "off" ||
      batch.reuseAndroidCleanDevices === true)
  ) {
    throw new Error(
      "idlePoolCap must be 0, reuseCleanDevices false and reuseAndroidCleanDevices false without --allow-reuse.",
    );
  }
  if (new Set(batch.clients.map((client) => client.name)).size !== batch.clients.length) {
    throw new Error("Broker batch client names must be unique.");
  }
  for (const client of batch.clients) {
    renderClientRequest(client, `validate-${client.name}`);
    if (!host.defaults[client.platform]) {
      throw new Error(`Client ${client.name} requires explicit ${client.platform} defaults.`);
    }
  }
  return batch;
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
