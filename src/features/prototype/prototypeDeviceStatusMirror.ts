import type { PrototypeEvent } from "../observe/android/ctrlProxyProtocol";
import { numberValid, object, type Rule } from "./prototypeBindingValidation";
import type {
  PrototypeStatusModule,
  PrototypeStatusValues,
} from "./prototypeDeviceStatusReference";
import { PROTOTYPE_PLATFORM_MODULES, type PrototypePlatformStateEntry } from "./prototypePlatform";
import {
  PROTOTYPE_LOCATION_UPDATED_EVENT,
  prototypeLocationEventSummary,
} from "./prototypeLocationPrivacy";
import {
  prototypePlatformDeliveredEventOf,
  type PrototypePlatformDeliveredEventPayload,
} from "./prototypePlatformEvent";

/** The device status modules whose `<module>.changed` values the host mirrors (#14316). */
export const PROTOTYPE_STATUS_MODULES: readonly PrototypeStatusModule[] = [
  "battery",
  "power",
  "audio",
];

/** The last values a device delivered for one status module. */
export interface PrototypeDeviceStatusReading {
  values: PrototypeStatusValues;
  /** Device time of the delivering event; an older replayed event never replaces this reading. */
  timestamp: number;
  /** Host clock time the delivering event was recorded. */
  receivedAt: number;
  /** The delivering event was injected by the host, not read from the device. */
  simulated?: true;
}

/**
 * A mirrored module: a device status module, or `location`, whose reading is only the accuracy-only
 * summary of the last delivered `location.updated` (#16463), never coordinates.
 */
export type PrototypeMirroredModule = PrototypeStatusModule | "location";

export type PrototypeDeviceStatusMirror = Partial<
  Record<PrototypeMirroredModule, PrototypeDeviceStatusReading>
>;

function statusModule(name: string): PrototypeStatusModule | undefined {
  return PROTOTYPE_STATUS_MODULES.find((module) => module === name);
}

function ruleAccepts(value: unknown, rule: Rule): boolean {
  switch (rule.kind) {
    case "number":
      return numberValid(value, rule);
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return (rule.values ?? []).some((allowed) => allowed === value);
    default:
      return false;
  }
}

/** The status module a delivered `<module>.changed` event names, when the event is untruncated. */
function changedModule(
  delivered: PrototypePlatformDeliveredEventPayload | undefined,
): PrototypeStatusModule | undefined {
  const dot = delivered?.event.indexOf(".") ?? -1;
  return delivered && !delivered.truncated && delivered.event.slice(dot + 1) === "changed"
    ? statusModule(delivered.event.slice(0, dot))
    : undefined;
}

/** Every key is in the module's state table and every value passes that key's contract rule. */
function stateValid(
  data: Record<string, unknown>,
  state: Record<string, PrototypePlatformStateEntry>,
): boolean {
  return Object.entries(data).every(
    ([key, value]) => Object.hasOwn(state, key) && ruleAccepts(value, state[key].value),
  );
}

/**
 * The module and values a delivered `battery|power|audio.changed` event carries, the accuracy-only
 * `location` reading a delivered `location.updated` carries, or undefined for any other event. Data that names a key outside the module's state table, or a value its contract rule
 * refuses, is not a reading: the mirror keeps the previous one rather than report malformed state.
 */
export function prototypeDeviceStatusOf(
  event: Pick<PrototypeEvent, "kind" | "name" | "payload">,
):
  | { module: PrototypeMirroredModule; values: PrototypeStatusValues; simulated?: true }
  | undefined {
  const delivered = prototypePlatformDeliveredEventOf(event);
  if (delivered?.event === PROTOTYPE_LOCATION_UPDATED_EVENT) {
    return locationReading(delivered);
  }
  const module = changedModule(delivered);
  const data = object(delivered?.data);
  const state = module ? PROTOTYPE_PLATFORM_MODULES[module]?.state : undefined;
  if (!module || !data || !state || !stateValid(data, state)) {
    return undefined;
  }
  return {
    module,
    values: { ...(data as PrototypeStatusValues) },
    ...(delivered?.simulated ? { simulated: true as const } : {}),
  };
}

/**
 * The presence-and-accuracy reading a delivered, untruncated `location.updated` carries: a finite,
 * non-negative `accuracyM` and a boolean `approximate`. Only those two fields are kept, whatever else
 * the data holds, so the mirror never reports coordinates.
 */
function locationReading(
  delivered: PrototypePlatformDeliveredEventPayload,
): { module: "location"; values: PrototypeStatusValues; simulated?: true } | undefined {
  const data = object(delivered.data);
  const accuracyM = data?.accuracyM;
  const approximate = data?.approximate;
  if (
    delivered.truncated ||
    typeof accuracyM !== "number" ||
    !Number.isFinite(accuracyM) ||
    accuracyM < 0 ||
    typeof approximate !== "boolean"
  ) {
    return undefined;
  }
  return {
    module: "location",
    values: { ...prototypeLocationEventSummary({ accuracyM, approximate }) },
    ...(delivered.simulated ? { simulated: true as const } : {}),
  };
}
