import { prototypeGeneratedForm } from "./prototypeGeneratedBindings";
import { defaultIdGenerator, type IdGenerator } from "../../utils/IdGenerator";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { PrototypeJson } from "./prototypeJson";
import { record } from "./prototypeTemplate";

/** One mutable scope per action-list invocation. Requests copy it when dispatched. */
export interface PrototypeActionContext {
  ids: IdGenerator;
  clock: Pick<Timer, "now">;
  lastGenerated?: string;
}

export function createPrototypeActionContext(
  ids: IdGenerator = defaultIdGenerator,
  clock: Pick<Timer, "now"> = defaultTimer,
): PrototypeActionContext {
  return { ids, clock };
}

/** Literal JSON is traversed in ascending UTF-16 member order; only exact generated forms are expanded. */
export function resolvePrototypeGeneratedJson(
  value: PrototypeJson,
  context: PrototypeActionContext,
): PrototypeJson {
  const form = prototypeGeneratedForm(value);
  if (form === "generate") {
    return (context.lastGenerated = context.ids.next());
  }
  if (form === "lastGenerated") {
    return context.lastGenerated!;
  }
  if (form === "now") {
    const ms = context.clock.now();
    return record(value)?.now === "iso" ? new Date(ms).toISOString() : ms;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolvePrototypeGeneratedJson(entry, context));
  }
  const object = record(value);
  return object
    ? Object.fromEntries(
        Object.entries(object)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [
            key,
            resolvePrototypeGeneratedJson(entry as PrototypeJson, context),
          ]),
      )
    : value;
}
