import contract from "../../../schemas/prototype-spec-contract.json";
import { record, type Raw } from "./prototypeTemplate";

/**
 * Finds every action list on one node for `automobile:prototype/eject` (#14129), wherever the
 * contract puts it: top-level fields (`onSubmit`, `onAppear`) and nested ones (`spans[].onTap`,
 * `swipeActions.end[].onTap`, dialog buttons). It never descends into child nodes, which the
 * writer emits on their own, or into an action, whose nested lists belong to that action.
 */

export interface EjectActionList {
  /** Spec path of the action array, e.g. `root.spans[0].onTap`. */
  readonly path: string;
  readonly actions: readonly unknown[];
}

const DEFINITIONS: Record<string, unknown> = contract.definitions;

function isRef(rule: unknown, name: string): boolean {
  const ref = record(rule);
  return ref?.kind === "ref" && ref.name === name;
}

function objectLists(fields: unknown, value: unknown, path: string): EjectActionList[] {
  const object = record(value);
  return object
    ? Object.entries(record(fields) ?? {}).flatMap(([name, field]) =>
        name in object ? walk(record(field)?.rule, object[name], `${path}.${name}`) : [],
      )
    : [];
}

function arrayLists(item: unknown, value: unknown, path: string): EjectActionList[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return isRef(item, "action")
    ? [{ path, actions: value }]
    : value.flatMap((entry, i) => walk(item, entry, `${path}[${i}]`));
}

type Walker = (rule: Raw, value: unknown, path: string) => EjectActionList[];

const WALKERS: Readonly<Record<string, Walker>> = {
  ref: (r, value, path) =>
    r.name === "node" || r.name === "action" ? [] : walk(DEFINITIONS[String(r.name)], value, path),
  array: (r, value, path) => arrayLists(r.item, value, path),
  map: (r, value, path) =>
    Object.entries(record(value) ?? {}).flatMap(([key, entry]) =>
      walk(r.item, entry, `${path}[${JSON.stringify(key)}]`),
    ),
  object: (r, value, path) => objectLists(r.fields, value, path),
  tagged: (r, value, path) => walk(record(r.variants)?.[String(record(value)?.type)], value, path),
  choice: (r, value, path) =>
    Array.isArray(r.options) ? r.options.flatMap((option) => walk(option, value, path)) : [],
};

function walk(rule: unknown, value: unknown, path: string): EjectActionList[] {
  const r = record(rule);
  const kind = r?.kind;
  const walker =
    typeof kind === "string" && Object.hasOwn(WALKERS, kind) ? WALKERS[kind] : undefined;
  return r && walker ? walker(r, value, path) : [];
}

/** Every action list on `node` other than its own `onTap`, which the dialects translate. */
export function untranslatedActionLists(node: unknown, path: string): EjectActionList[] {
  const lists = walk(DEFINITIONS.node, node, path).filter((list) => list.path !== `${path}.onTap`);
  // A choice can reach one field through two options; keep each path once.
  return [...new Map(lists.map((list) => [list.path, list])).values()];
}
