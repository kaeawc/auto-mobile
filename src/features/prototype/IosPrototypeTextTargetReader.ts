import { z } from "zod";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { PrototypeAgentConnections } from "./ios/iosPrototypeTransport";
import type {
  PrototypeTextFieldBindings,
  PrototypeTextReading,
  PrototypeTextTarget,
  PrototypeTextTargetReader,
} from "./prototypeTextTarget";

const statusSchema = z.object({
  shown: z.boolean(),
  id: z.string().nullable(),
  state: z.record(z.union([z.string(), z.number().finite(), z.boolean()])),
});

function readPrototypeState(
  reply: unknown,
  prototypeId: string,
  key: string,
): PrototypeTextReading {
  const status = statusSchema.safeParse(reply);
  if (!status.success) {
    logger.warn("Malformed prototype status", status.error);
    return { kind: "unverifiable", reason: "malformed prototype status" };
  }
  if (!status.data.shown) {
    return { kind: "unverifiable", reason: "prototype is not shown" };
  }
  if (status.data.id !== prototypeId) {
    return { kind: "unverifiable", reason: "a different prototype id is showing" };
  }
  const value = Object.hasOwn(status.data.state, key) ? status.data.state[key] : "";
  return {
    kind: "value",
    source: "state",
    stateKey: key,
    value: String(value),
    ...(typeof value === "number" ? { numericValue: value } : {}),
  };
}

export class IosPrototypeTextTargetReader implements PrototypeTextTargetReader {
  constructor(
    private readonly dependencies: {
      deviceId: string;
      connections: PrototypeAgentConnections;
      bindings: PrototypeTextFieldBindings;
    },
  ) {}

  async read(target: PrototypeTextTarget, signal?: AbortSignal): Promise<PrototypeTextReading> {
    const { deviceId, connections, bindings } = this.dependencies;
    const binding = bindings.forDevice(deviceId);
    if (!binding) {
      return { kind: "unverifiable", reason: "no shown prototype bindings for this device" };
    }
    const key = target.identifiers
      .map((id) => binding.keys.get(id))
      .find((key) => key !== undefined);
    if (key === undefined) {
      return {
        kind: "unverifiable",
        reason: `no text-field binding for target identifiers ${JSON.stringify(target.identifiers)}`,
      };
    }
    const agent = connections.get(deviceId);
    if (!agent) {
      return { kind: "unverifiable", reason: "no prototype agent connection for this device" };
    }
    try {
      signal?.throwIfAborted();
      const reply = await agent.request("get_prototype_status");
      signal?.throwIfAborted();
      if (!reply.success) {
        return {
          kind: "unverifiable",
          reason: `prototype status request failed: ${reply.error ?? "unknown error"}`,
        };
      }
      return readPrototypeState(reply.status, binding.prototypeId, key);
    } catch (error) {
      logger.warn("Prototype text status read failed", error);
      return {
        kind: "unverifiable",
        reason: `prototype status request failed: ${errorMessage(error)}`,
      };
    }
  }
}
