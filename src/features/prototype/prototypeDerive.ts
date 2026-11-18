import { resolvePrototypeDataPointer } from "./prototypeData";
import { record } from "./prototypeTemplate";
import type { PrototypeDerivedEntry } from "./prototypeFormatSchema";
import { prototypeRenderLimits } from "./prototypeRenderContract.generated";

export interface PrototypeDeriveChanges {
  dataPointers: ReadonlySet<string>;
  stateKeys: ReadonlySet<string>;
}
export interface PrototypeDeriveObserver {
  recomputed(name: string): void;
}
type Collection = Extract<PrototypeDerivedEntry, { collection: unknown }>;

function matches(
  item: Record<string, unknown>,
  clause: NonNullable<Collection["collection"]["where"]>[number],
  state: Record<string, unknown>,
): boolean {
  const left = Object.hasOwn(item, clause.field) ? item[clause.field] : undefined;
  const right =
    "state" in clause.value
      ? Object.hasOwn(state, clause.value.state)
        ? state[clause.value.state]
        : undefined
      : clause.value.value;
  if (clause.op === "contains") {
    return (
      typeof left === "string" &&
      typeof right === "string" &&
      left.toLowerCase().includes(right.toLowerCase())
    );
  }
  if ((typeof left !== "number" && typeof left !== "string") || typeof left !== typeof right) {
    return false;
  }
  if (!sortable(left) || !sortable(right)) {
    return false;
  }
  return compareClause(clause.op, compareValues(left, right));
}

function compareClause(op: Exclude<Clause["op"], "contains">, comparison: number): boolean {
  switch (op) {
    case "eq":
      return comparison === 0;
    case "neq":
      return comparison !== 0;
    case "gt":
      return comparison > 0;
    case "gte":
      return comparison >= 0;
    case "lt":
      return comparison < 0;
    case "lte":
      return comparison <= 0;
  }
}

type Clause = NonNullable<Collection["collection"]["where"]>[number];
function sortable(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function compareValues(left: string | number, right: string | number): number {
  if (typeof left === "number") {
    return typeof right === "number" ? left - right : -1;
  }
  return typeof right === "string" ? compareStrings(left, right) : 1;
}

function compareRows(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  sort: NonNullable<Collection["collection"]["sort"]>,
): number {
  const left = Object.hasOwn(a, sort.field) ? a[sort.field] : undefined;
  const right = Object.hasOwn(b, sort.field) ? b[sort.field] : undefined;
  if (!sortable(left) || !sortable(right)) {
    return Number(sortable(right)) - Number(sortable(left));
  }
  const comparison = compareValues(left, right);
  return sort.order === "desc" ? -comparison : comparison;
}

/** Unicode code points, independent of host locale and UTF-16 surrogate ordering. */
function compareStrings(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return a.length - b.length;
}

function collect(entry: Collection, data: unknown, state: Record<string, unknown>): unknown {
  const source = resolvePrototypeDataPointer(data, entry.collection.of.data);
  const items = (
    Array.isArray(source)
      ? source.slice(0, Math.min(500, prototypeRenderLimits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS))
      : []
  )
    .filter((item): item is Record<string, unknown> => record(item) !== undefined)
    .filter((item) =>
      (entry.collection.where ?? []).every((clause) => matches(item, clause, state)),
    );
  const sort = entry.collection.sort;
  if (sort) {
    items.sort((a, b) => compareRows(a, b, sort));
  }
  const rows =
    entry.collection.limit === undefined ? items : items.slice(0, entry.collection.limit);
  if (!entry.reduce) {
    return rows;
  }
  if (entry.reduce.op === "count") {
    return rows.length;
  }
  const field = entry.reduce.field;
  const numbers = rows.flatMap((item) =>
    Object.hasOwn(item, field) && typeof item[field] === "number" && Number.isFinite(item[field])
      ? [item[field] as number]
      : [],
  );
  if (entry.reduce.op === "sum") {
    return numbers.reduce((sum, value) => sum + value, 0);
  }
  return numbers.length
    ? entry.reduce.op === "min"
      ? Math.min(...numbers)
      : Math.max(...numbers)
    : 0;
}

function inputs(entry: PrototypeDerivedEntry): { pointer?: string; keys: string[] } {
  if ("collection" in entry) {
    return {
      pointer: entry.collection.of.data,
      keys: (entry.collection.where ?? []).flatMap((clause) =>
        "state" in clause.value ? [clause.value.state] : [],
      ),
    };
  }
  return {
    pointer: "data" in entry.of ? entry.of.data : undefined,
    keys: "state" in entry.of ? [entry.of.state] : [],
  };
}

function affected(entry: PrototypeDerivedEntry, changed: PrototypeDeriveChanges): boolean {
  const { pointer, keys } = inputs(entry);
  const dataChanged =
    pointer !== undefined &&
    [...changed.dataPointers].some(
      (path) =>
        path === pointer || path.startsWith(pointer + "/") || pointer.startsWith(path + "/"),
    );
  return dataChanged || keys.some((key) => changed.stateKeys.has(key));
}

function evaluate(
  entry: PrototypeDerivedEntry,
  data: unknown,
  state: Record<string, unknown>,
): unknown {
  if ("collection" in entry) {
    return collect(entry, data, state);
  }
  if ("data" in entry.of) {
    return resolvePrototypeDataPointer(data, entry.of.data);
  }
  if ("state" in entry.of) {
    return Object.hasOwn(state, entry.of.state) ? state[entry.of.state] : undefined;
  }
  return entry.of.value;
}

/** Raw values only; display formatting remains in the existing placeholder resolver. */
export function derivePrototypeValues(
  derive: Record<string, PrototypeDerivedEntry> | undefined,
  data: unknown,
  state: Record<string, unknown>,
  ...incremental: [
    previous?: Record<string, unknown>,
    changed?: PrototypeDeriveChanges,
    observer?: PrototypeDeriveObserver,
  ]
): Record<string, unknown> {
  const [previous, changed, observer] = incremental;
  const result: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(derive ?? {})) {
    const reused =
      previous && Object.hasOwn(previous, name) && changed && !affected(entry, changed);
    if (!reused) {
      observer?.recomputed(name);
    }
    const value = reused ? previous[name] : evaluate(entry, data, state);
    Object.defineProperty(result, name, { value, enumerable: true });
  }
  return result;
}

interface DeriveRevision {
  data: unknown;
  state: Record<string, unknown>;
  values: Record<string, unknown>;
}
const revisions = new WeakMap<object, DeriveRevision>();

function changedStateKeys(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Set<string> {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return new Set(
    [...keys].filter(
      (key) =>
        Object.hasOwn(previous, key) !== Object.hasOwn(next, key) ||
        !Object.is(previous[key], next[key]),
    ),
  );
}

/**
 * Derived values memoized per derive block: an unchanged data reference and shallow-equal state
 * reuse the last values, and a change recomputes only the entries `affected` by it. Data is
 * treated as immutable per revision; a new data reference invalidates every data-backed entry.
 */
export function memoizedPrototypeDerive(
  derive: Record<string, PrototypeDerivedEntry> | undefined,
  data: unknown,
  state: Record<string, unknown>,
  observer?: PrototypeDeriveObserver,
): Record<string, unknown> {
  if (!derive) {
    return {};
  }
  const previous = revisions.get(derive);
  const snapshot = { ...state };
  if (!previous) {
    const values = derivePrototypeValues(derive, data, snapshot, undefined, undefined, observer);
    revisions.set(derive, { data, state: snapshot, values });
    return values;
  }
  const stateKeys = changedStateKeys(previous.state, snapshot);
  const dataChanged = !Object.is(previous.data, data);
  if (!dataChanged && stateKeys.size === 0) {
    return previous.values;
  }
  const values = derivePrototypeValues(
    derive,
    data,
    snapshot,
    previous.values,
    { dataPointers: new Set(dataChanged ? [""] : []), stateKeys },
    observer,
  );
  revisions.set(derive, { data, state: snapshot, values });
  return values;
}
