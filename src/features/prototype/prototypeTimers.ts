import { ActionableError } from "../../models/ActionableError";
import contract from "../../../schemas/prototype-spec-contract.json";
import { PROTOTYPE_TIMERS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { prototypeFieldsOfKind } from "./prototypeEmitContext";
import {
  visitPrototypeHandlerFields,
  mapBindableFields,
  record,
  type Raw,
} from "./prototypeTemplate";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
export const prototypeTimerFields = (spec: unknown): string[] =>
  prototypeFieldsOfKind(spec, "timer");
type Located = readonly { value: Raw; path: string }[];
export function prototypeTimersError(
  actions: Located,
): { path: string; message: string } | undefined {
  const ids = new Set<string>();
  for (const { value, path } of actions) {
    if (value.type !== "startTimer") {
      continue;
    }
    if (value.maxRuns !== undefined && value.everyMs === undefined) {
      return { path: `${path}.maxRuns`, message: "maxRuns requires everyMs" };
    }
    if (typeof value.id === "string") {
      ids.add(value.id);
    }
    if (ids.size > contract.limits.MAX_PROTOTYPE_TIMERS) {
      return { path: `${path}.id`, message: "Too many distinct timer ids" };
    }
  }
  return undefined;
}
/** Timer actions only: payloads/data are opaque; handlers and unused definitions are included. */
export function prototypeTimerActions(spec: unknown): { value: Raw; path: string }[] {
  const actions: { value: Raw; path: string }[] = [];
  const visit = (value: unknown, path: string, kind: string): unknown => {
    const action = record(value);
    if (kind === "timer" && action) {
      actions.push({ value: action, path });
    }
    return value;
  };
  walkPrototypeNodes(spec, (node, path) => {
    mapBindableFields(node, path, visit);
  });
  visitPrototypeHandlerFields(spec, visit);
  return actions;
}
/** Host-only advisory; cancelling an undeclared id remains a valid runtime no-op. */
export function prototypeTimerWarnings(spec: unknown): string[] {
  const actions = prototypeTimerActions(spec);
  const starts = new Set(
    actions.filter(({ value }) => value.type === "startTimer").map(({ value }) => value.id),
  );
  return actions
    .filter(({ value }) => value.type === "cancelTimer" && !starts.has(value.id))
    .map(
      ({ value, path }) =>
        `${path}: cancelTimer id ${JSON.stringify(value.id)} has no matching startTimer; cancelling it is a no-op.`,
    );
}
export function prototypeTimersUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  return `The connected device does not advertise ${PROTOTYPE_TIMERS_CAPABILITY} required at ${fields[0] ?? "simulate"}. Nothing was sent. ${update}, or remove timers.`;
}

/** Low-level Android guard, including callers outside the prototype tool. */
export function requirePrototypeTimersSupport(
  requestType: string,
  supports: (capability: string) => boolean | undefined,
): void {
  if (requestType === "advance_prototype_clock" && supports(PROTOTYPE_TIMERS_CAPABILITY) !== true) {
    throw new ActionableError(prototypeTimersUnsupportedMessage([], "android"));
  }
}
