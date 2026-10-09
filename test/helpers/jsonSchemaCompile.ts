import Ajv, { type Options, type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";

// Constructing an Ajv instance is cheap, but its first compile also compiles the draft's
// meta-schema to validate the input schema: ~50 ms per instance, every time. A test that
// builds `new Ajv2020(...)` in its body pays that against the 100 ms budget, so tests share
// one instance per draft and options instead. Compiled validators are cached by schema
// object, and validation is the same as on a fresh instance with the same options.
const sharedInstances = new Map<string, Ajv>();

function shared(draft: "07" | "2020", options: Options): Ajv {
  const key = `${draft}:${JSON.stringify(options)}`;
  let ajv = sharedInstances.get(key);
  if (!ajv) {
    ajv = draft === "2020" ? new Ajv2020(options) : new Ajv(options);
    sharedInstances.set(key, ajv);
  }
  return ajv;
}

function compileOn<T>(ajv: Ajv, schema: unknown): ValidateFunction<T> {
  // A schema with an $id registers under it; drop an earlier one so a re-compile of a
  // changed schema with the same $id replaces it rather than throwing.
  const id = (schema as { $id?: unknown } | null)?.$id;
  if (typeof id === "string") {
    ajv.removeSchema(id);
  }
  return ajv.compile<T>(schema as object);
}

/** Compile `schema` as JSON Schema 2020-12 on a process-wide Ajv2020 for `options`. */
export function compileAjv2020<T = unknown>(
  schema: unknown,
  options: Options = { strict: false },
): ValidateFunction<T> {
  return compileOn<T>(shared("2020", options), schema);
}

/** Compile `schema` as JSON Schema draft-07 on a process-wide Ajv for `options`. */
export function compileAjv<T = unknown>(schema: unknown, options: Options): ValidateFunction<T> {
  return compileOn<T>(shared("07", options), schema);
}

export function compileJsonSchema(schema: unknown): void {
  compileAjv2020(schema);
}

// Pay Ajv's cold start and the default instance's meta-schema compile while the test file
// imports this helper, not inside whichever test compiles first.
compileAjv2020({ type: "object" });
