import type {
  PrototypePlatformSimulationRequest,
  SimulatePrototypePlatformMessage,
} from "../observe/android/ctrlProxyProtocol/prototypeMessages";
import { ActionableError } from "../../models/ActionableError";
import { decodePrototypeCastEvent } from "./prototypeCastEvents";
import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeJsonObjectSchema } from "./prototypeJson";
import { prototypePlatformEvent } from "./prototypePlatform";

import { PROTOTYPE_PLATFORM_SIMULATION_CAPABILITY } from "../observe/android/ctrlProxyProtocol/capabilities";
export function prototypePlatformSimulationUnsupportedMessage(): string {
  return `simulate: platform event injection requires the connected prototype runtime advertising ${PROTOTYPE_PLATFORM_SIMULATION_CAPABILITY}. Update the connected prototype runtime and use a module that supports simulation (debug test.tick).`;
}
/** Reuse event data decoders where defined; other module events accept arbitrary JSON objects. */
export function prototypePlatformSimulationIssue(
  event: string,
  data: unknown,
): [string, string] | undefined {
  const definition = prototypePlatformEvent(event);
  if (!definition) {
    return [
      "event",
      `Unknown platform event "${event}". Use a known <module>.<event> from the prototype contract, for example test.tick on debug CtrlProxy.`,
    ];
  }
  const parsed = prototypeJsonObjectSchema.safeParse(data);
  if (!parsed.success) {
    return ["data", "simulate data must be a JSON object containing only JSON values"];
  }
  if (definition.module === "cast" && !decodePrototypeCastEvent(event, parsed.data)) {
    return [
      "data",
      `simulate data must match the ${event} event definition; use its documented cast event fields`,
    ];
  }
  // Count the entire delivered emit so an accepted injection is never truncated by the runtime.
  const bytes = Buffer.byteLength(
    JSON.stringify({ event, data: parsed.data, simulated: true }),
    "utf8",
  );
  if (bytes > contract.limits.MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES) {
    return ["data", "simulate event payload exceeds the 4096-byte emit budget; reduce data"];
  }
  return undefined;
}

/** Refuse before dispatch, including when an older connection has no capability list. */
export function requirePrototypePlatformSimulationSupport(
  requestType: string,
  supports: (capability: string) => boolean | undefined,
): void {
  if (
    requestType === "simulate_prototype_platform" &&
    supports(PROTOTYPE_PLATFORM_SIMULATION_CAPABILITY) !== true
  ) {
    throw new ActionableError(prototypePlatformSimulationUnsupportedMessage());
  }
}

/** Typed wire builder shared by direct client requests and the host tool path. */
export function simulatePrototypePlatformMessage(
  args: PrototypePlatformSimulationRequest & { requestId?: string },
): SimulatePrototypePlatformMessage {
  const issue = prototypePlatformSimulationIssue(args.event, args.data);
  if (!args.id || issue) {
    throw new ActionableError(issue?.[1] ?? "simulate requires id");
  }
  return {
    type: "simulate_prototype_platform",
    requestId: args.requestId ?? "",
    id: args.id,
    event: args.event,
    data: args.data,
  };
}
