import { record, type Raw } from "./prototypeTemplate";

/** Host-side checks for repeat fields named by `repeat.derive`, mirroring `PrototypeDerivedRepeatKeys`. */
interface DerivedKeyError {
  path: string;
  message: string;
}

/** The parts of a repeat scope a derived key check reads. */
interface DerivedKeyScope {
  items: readonly Readonly<Raw>[];
  derivedFields: ReadonlySet<string>;
}

/**
 * A derived key's string is formatted on the device, but one entry formats equal inputs to equal
 * strings, so two rows that feed it the same input always share a key (#18665).
 */
export function derivedRepeatKeyError(
  node: Raw,
  scope: DerivedKeyScope,
  key: string,
  path: string,
): DerivedKeyError | undefined {
  const of = record(record(record(record(node.repeat)?.derive)?.[key])?.of);
  if (!of || scope.items.length < 2) {
    return undefined;
  }
  const constant = Object.hasOwn(of, "value");
  const field = of.item;
  if (!constant && (typeof field !== "string" || scope.derivedFields.has(field))) {
    return undefined;
  }
  const seen = new Map<string, number>();
  for (const [index, item] of scope.items.entries()) {
    const input = derivedKeyInput(constant, item, String(field));
    if (input === undefined) {
      continue;
    }
    const first = seen.get(input);
    if (first !== undefined) {
      return {
        path,
        message: `Derived repeat key ${JSON.stringify(key)} has the same input for items ${first} and ${index}`,
      };
    }
    seen.set(input, index);
  }
  return undefined;
}

/** The row's input to a derived key, or `undefined` when it is not a comparable scalar. */
function derivedKeyInput(
  constant: boolean,
  item: Readonly<Raw>,
  field: string,
): string | undefined {
  if (constant) {
    return "constant";
  }
  const value = Object.hasOwn(item, field) ? item[field] : undefined;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? // `String(-0)` is "0", but a formatter renders -0 as "-0": keep the sign apart.
      `${typeof value}:${Object.is(value, -0) ? "-0" : String(value)}`
    : undefined;
}

/**
 * A derive name that is also a field of an inner row would replace that field, so it is rejected
 * like an outer repeat's (`repeatDerivedError`), once per outer row (#18665).
 */
export function innerDeriveCollisionError(
  node: Raw,
  path: string,
  rows: unknown,
): DerivedKeyError | undefined {
  const name = Object.keys(record(record(node.repeat)?.derive) ?? {}).find(
    (key) => Array.isArray(rows) && rows.some((row) => Object.hasOwn(record(row) ?? {}, key)),
  );
  return name === undefined
    ? undefined
    : {
        path: `${path}.repeat.derive.${name}`,
        message: "Derived name collides with an item field",
      };
}
