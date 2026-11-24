import { record } from "./prototypeTemplate";

export function prototypeGeneratedForm(
  value: unknown,
): "generate" | "now" | "lastGenerated" | undefined {
  const binding = record(value);
  if (!binding || Object.keys(binding).length !== 1) {
    return undefined;
  }
  if (binding.generate === "id") {
    return "generate";
  }
  if (binding.now === "epochMs" || binding.now === "iso") {
    return "now";
  }
  return binding.lastGenerated === true ? "lastGenerated" : undefined;
}

/**
 * Binding destinations only: never inspect callback lists or arbitrary payload properties. An
 * `{object}` data value contributes its member bindings in sorted name order, the order every
 * platform resolves them (#18826).
 */
export function prototypeActionBindings(action: Record<string, unknown>): unknown[] {
  const values: unknown[] = [];
  if (
    ["setData", "appendData", "upsertData", "prependData", "setState"].includes(String(action.type))
  ) {
    const value = record(action.value);
    const members = action.type === "setState" ? undefined : record(value?.object);
    values.push(...(members ? sortedValues(members) : [action.value]));
  }
  if (action.type === "request") {
    values.push(...sortedValues(action.headers), ...sortedValues(action.query));
    const body = record(action.body);
    if (body?.form) {
      values.push(...sortedValues(body.form));
    } else if (Array.isArray(body?.multipart)) {
      values.push(...body.multipart.map((part) => record(part)?.value));
    } else {
      values.push(action.body);
    }
  }
  if (["setData", "removeData", "request"].includes(String(action.type))) {
    values.push(record(action.where)?.equals);
  }
  return values;
}

/** Visits generation markers inside a binding or its literal JSON, in evaluation order. */
export function prototypeGeneratedForms(value: unknown): ("generate" | "now" | "lastGenerated")[] {
  const form = prototypeGeneratedForm(value);
  if (form) {
    return [form];
  }
  const binding = record(value);
  if (!binding || !Object.hasOwn(binding, "value")) {
    return [];
  }
  return literalForms(binding.value);
}
function literalForms(value: unknown): ("generate" | "now" | "lastGenerated")[] {
  const form = prototypeGeneratedForm(value);
  if (form) {
    return [form];
  }
  return (Array.isArray(value) ? value : sortedValues(value)).flatMap(literalForms);
}

/** Follow-ups inherit the scope at dispatch, independent of later sibling actions. */
export function prototypeGeneratedValuesError(
  actions: readonly { value: Record<string, unknown>; path: string }[],
): { path: string; message: string; code: "lastGenerated_unset" } | undefined {
  const lists = new Map<string, (typeof actions)[number][]>();
  for (const action of actions) {
    const path = action.path.slice(0, action.path.lastIndexOf("["));
    const list = lists.get(path) ?? [];
    list.push(action);
    lists.set(path, list);
  }
  const check = (
    path: string,
    inherited: boolean,
  ): ReturnType<typeof prototypeGeneratedValuesError> => {
    let generated = inherited;
    for (const action of lists.get(path) ?? []) {
      for (const form of prototypeActionBindings(action.value).flatMap(prototypeGeneratedForms)) {
        if (form === "generate") {
          generated = true;
        }
        if (form === "lastGenerated" && !generated) {
          return {
            path: action.path,
            message: "lastGenerated_unset: no preceding generate in this action list",
            code: "lastGenerated_unset",
          };
        }
      }
      for (const branch of ["onSuccess", "onError"]) {
        const error = check(`${action.path}.${branch}`, generated);
        if (error) {
          return error;
        }
      }
    }
    return undefined;
  };
  for (const path of lists.keys()) {
    if (path.endsWith(".onSuccess") || path.endsWith(".onError")) {
      continue;
    }
    const error = check(path, false);
    if (error) {
      return error;
    }
  }
  return undefined;
}

function sortedValues(value: unknown): unknown[] {
  const object = record(value) ?? {};
  return Object.keys(object)
    .sort()
    .map((key) => object[key]);
}

export function prototypeActionNeedsDataV2(action: Record<string, unknown>): boolean {
  return (
    action.where !== undefined ||
    action.member !== undefined ||
    prototypeActionBindings(action).some((value) => prototypeGeneratedForms(value).length > 0)
  );
}
