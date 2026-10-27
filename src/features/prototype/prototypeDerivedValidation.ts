import {
  fail,
  object,
  type Located,
  type PrototypeValidationError,
} from "./prototypeBindingValidation";
import { dataPlaceholderSpans, resolvePrototypeDataPointer } from "./prototypeData";
import { mapBindableFields, STATE_KEY } from "./prototypeTemplate";

function fractionError(derive: unknown, path: string): PrototypeValidationError | undefined {
  for (const [name, raw] of Object.entries(object(derive) ?? {})) {
    const format = object(object(raw)?.format);
    for (const kind of ["number", "percent"]) {
      const options = object(format?.[kind]);
      if (
        typeof options?.minFraction === "number" &&
        typeof options.maxFraction === "number" &&
        options.minFraction > options.maxFraction
      ) {
        return fail(
          `${path}.${name}.format.${kind}.minFraction`,
          "minFraction cannot exceed maxFraction",
        );
      }
    }
  }
  return undefined;
}

function repeatDerivedError(
  value: Record<string, unknown>,
  path: string,
  data: Record<string, unknown>,
): PrototypeValidationError | undefined {
  const repeat = object(value.repeat);
  const entries = object(repeat?.derive);
  const fractions = fractionError(entries, `${path}.repeat.derive`);
  if (fractions) {
    return fractions;
  }
  const source = object(repeat?.items);
  const items =
    source && typeof source.path === "string"
      ? resolvePrototypeDataPointer(data.data, source.path)
      : repeat?.items;
  for (const name of Object.keys(entries ?? {})) {
    if (Array.isArray(items) && items.some((item) => Object.hasOwn(object(item) ?? {}, name))) {
      return fail(`${path}.repeat.derive.${name}`, "Derived name collides with an item field");
    }
  }
  return undefined;
}

function derivedReadError(
  value: Record<string, unknown>,
  path: string,
  derived: Record<string, unknown>,
): PrototypeValidationError | undefined {
  let first: PrototypeValidationError | undefined;
  mapBindableFields(value, path, (text, at, kind) => {
    if (kind === "text" && typeof text === "string") {
      for (const { pointer: name } of dataPlaceholderSpans(text, "derived:", (name) =>
        STATE_KEY.test(name),
      )) {
        if (!Object.hasOwn(derived, name)) {
          first ??= fail(at, `Unknown derived value ${JSON.stringify(name)}`);
        }
      }
    }
    return text;
  });
  return first;
}

export function prototypeDerivedError(
  spec: unknown,
  nodes: Located[],
): PrototypeValidationError | undefined {
  const data = object(spec) ?? {};
  const derived = object(data.derive) ?? {};
  const fractions = fractionError(derived, "derive");
  if (fractions) {
    return fractions;
  }
  for (const { value, path } of nodes) {
    const error = derivedReadError(value, path, derived) ?? repeatDerivedError(value, path, data);
    if (error) {
      return error;
    }
  }
  return undefined;
}
