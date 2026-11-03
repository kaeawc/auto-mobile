import type { PrototypeEvent } from "../observe/android/ctrlProxyProtocol";
import { numberValid, object, type Rule } from "./prototypeBindingValidation";
import type { PrototypeStatusModule, PrototypeStatusValues } from "./prototypeDeviceStatusReference";
import { PROTOTYPE_PLATFORM_MODULES } from "./prototypePlatform";
import { prototypePlatformDeliveredEventOf } from "./prototypePlatformEvent";

/** The device status modules whose `<module>.changed` values the host mirrors (#14316). */
export const PROTOTYPE_STATUS_MODULES: readonly PrototypeStatusModule[] = [
  "battery",
  "power",
  "audio",
];

/** The last values a device delivered for one status module. */
export interface PrototypeDeviceStatusReading {
  values: PrototypeStatusValues;
  /** Host clock time the delivering event was recorded. */
  receivedAt: number;
  /** The delivering event was injected by the host, not read from the device. */
  simulated?: true;
}

export type PrototypeDeviceStatusMirror = Partial<
  Record<PrototypeStatusModule, PrototypeDeviceStatusReading>
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

/**
 * The module and values a delivered `battery|power|audio.changed` event carries, or undefined for any
 * other event. Data that names a key outside the module's state table, or a value its contract rule
 * refuses, is not a reading: the mirror keeps the previous one rather than report malformed state.
 */
export function prototypeDeviceStatusOf(
  event: Pick<PrototypeEvent, "kind" | "name" | "payload">,
): { module: PrototypeStatusModule; values: PrototypeStatusValues; simulated?: true } | undefined {
  const delivered = prototypePlatformDeliveredEventOf(event);
  const dot = delivered?.event.indexOf(".") ?? -1;
  if (!delivered || delivered.truncated || delivered.event.slice(dot + 1) !== "changed") {
    return undefined;
  }
  const module = statusModule(delivered.event.slice(0, dot));
  const data = object(delivered.data);
  const state = module ? PROTOTYPE_PLATFORM_MODULES[module]?.state : undefined;
  if (!module || !data || !state) {
    return undefined;
  }
  const valid = Object.entries(data).every(
    ([key, value]) => Object.hasOwn(state, key) && ruleAccepts(value, state[key].value),
  );
  return valid
    ? {
        module,
        values: { ...(data as PrototypeStatusValues) },
        ...(delivered.simulated ? { simulated: true as const } : {}),
      }
    : undefined;
}
