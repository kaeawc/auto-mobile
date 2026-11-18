import { projectPrototypeDerivedItem, type PrototypeFormatEnvironment } from "../prototypeFormat";
import { derivePrototypeValues } from "../prototypeDerive";
import type { PrototypeDerivedEntry } from "../prototypeFormatSchema";
import { prototypeRenderLimits } from "../prototypeRenderContract.generated";
import { resolvePrototypeDataPointer } from "../prototypeData";
import { record, type Raw, type Instance } from "../prototypeTemplate";

/** Repeat expansion is bounded so one spec cannot produce an unbounded page. */
export const MAX_WEB_REPEAT_ITEMS = 200;

/**
 * How many rows a container's repeat draws. A lazy `list` draws up to the list contract limit,
 * capped by its own `maxItems`, as the devices do; every other repeat keeps the web cap.
 */
export function webRepeatLimit(node: Raw): number {
  if (node.type !== "list") {
    return MAX_WEB_REPEAT_ITEMS;
  }
  const listLimit = prototypeRenderLimits.MAX_PROTOTYPE_LIST_ITEMS;
  const maxItems = node.maxItems;
  return typeof maxItems === "number" && Number.isInteger(maxItems) && maxItems >= 0
    ? Math.min(maxItems, listLimit)
    : listLimit;
}

/**
 * A repeat's rows: a literal array or a pointer into the spec's data. As on the devices, only
 * object items repeat (scalars are skipped before indices are assigned), up to `limit`.
 */
export function webRepeatRows(
  repeat: Raw,
  data: unknown,
  limit: number,
  derived: Record<string, unknown> = {},
): unknown[] {
  const itemsPath = record(repeat.items)?.path;
  const items = Array.isArray(repeat.items)
    ? repeat.items
    : typeof itemsPath === "string"
      ? resolvePrototypeDataPointer(data, itemsPath)
      : typeof record(repeat.items)?.derived === "string"
        ? derived[String(record(repeat.items)?.derived)]
        : undefined;
  const rows = Array.isArray(items) ? items.filter((item) => record(item) !== undefined) : [];
  return rows.slice(0, limit);
}

interface WebRepeatScope {
  spec: Raw;
  data: unknown;
  condition: { state: Raw };
  instances?: readonly Instance[];
}

/** Resolve top-level collection bindings before the existing repeat row projection. */
export function webRepeatRowsForScope(node: Raw, scope: WebRepeatScope): unknown[] {
  const values = derivePrototypeValues(
    record(scope.spec.derive) as Record<string, PrototypeDerivedEntry> | undefined,
    scope.data,
    scope.condition.state,
  );
  const repeat = record(node.repeat) ?? {};
  const field = record(repeat.items)?.field;
  const nested = typeof field === "string";
  const limit = nested
    ? prototypeRenderLimits.MAX_PROTOTYPE_INNER_REPEAT_ITEMS
    : webRepeatLimit(node);
  return webRepeatRows(
    nested ? { ...repeat, items: scope.instances?.at(-1)?.values[field] } : repeat,
    scope.data,
    limit,
    values,
  );
}

/** Bind one row with its enclosing item, retaining both aliases and both indices. */
export function webRepeatInstances(
  node: Raw,
  scope: WebRepeatScope & { format: PrototypeFormatEnvironment },
): Instance[] {
  const repeat = record(node.repeat) ?? {};
  const alias = typeof repeat.as === "string" ? repeat.as : "item";
  const derive = record(repeat.derive) as
    | Parameters<typeof projectPrototypeDerivedItem>[0]
    | undefined;
  const outer = scope.instances?.at(-1);
  const outerFields = outer
    ? {
        ...Object.fromEntries(
          Object.entries(outer.values).map(([name, value]) => [`outer.${name}`, value]),
        ),
        $outerIndex: outer.index,
      }
    : {};
  return webRepeatRowsForScope(node, scope).map((item, index) => {
    const values = record(item) ?? {};
    return {
      binding: { alias, index: true, ...(outer ? { outerAlias: outer.binding.alias } : {}) },
      values: {
        ...(derive ? projectPrototypeDerivedItem(derive, values, scope.format) : values),
        ...outerFields,
      },
      index,
    };
  });
}
