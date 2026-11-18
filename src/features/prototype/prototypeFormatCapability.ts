import { prototypeSpecNodeRoots, prototypeNodeChildren } from "./prototypeNodeChildren";
import { record } from "./prototypeTemplate";
export function prototypeFormatFields(spec: unknown): string[] {
  const fields = Object.values(record(record(spec)?.derive) ?? {}).some(
    (entry) =>
      !Object.hasOwn(record(entry) ?? {}, "collection") ||
      Object.hasOwn(record(entry) ?? {}, "format"),
  )
    ? ["derive"]
    : [];
  const pending = prototypeSpecNodeRoots(spec).reverse();
  while (pending.length) {
    const { node, path } = pending.pop()!;
    const value = record(node);
    if (!value) {
      continue;
    }
    if (Object.hasOwn(record(value.repeat) ?? {}, "derive")) {
      fields.push(`${path}.repeat.derive`);
    }
    pending.push(
      ...prototypeNodeChildren(value)
        .map((child) => ({ node: child.value, path: `${path}${child.suffix}` }))
        .reverse(),
    );
  }
  return fields;
}
export function prototypeFormatUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return `The connected ${platform === "ios" ? "iOS prototype agent" : "CtrlProxy"} does not advertise prototype_format_v1, so it cannot format values at ${fields[0]}. Nothing was shown. Update the connected renderer, or use literal display strings.`;
}

export function prototypeDeriveFields(spec: unknown): string[] {
  const fields = Object.entries(record(record(spec)?.derive) ?? {})
    .filter(([, entry]) => Object.hasOwn(record(entry) ?? {}, "collection"))
    .map(([name]) => `derive.${name}.collection`);
  const pending = prototypeSpecNodeRoots(spec);
  while (pending.length) {
    const { node, path } = pending.pop()!;
    const value = record(node);
    if (!value) {
      continue;
    }
    if (Object.hasOwn(record(record(value.repeat)?.items) ?? {}, "derived")) {
      fields.push(`${path}.repeat.items.derived`);
    }
    pending.push(
      ...prototypeNodeChildren(value).map((child) => ({
        node: child.value,
        path: `${path}${child.suffix}`,
      })),
    );
  }
  return fields;
}
export function prototypeDeriveUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return `The connected ${platform === "ios" ? "iOS prototype agent" : "CtrlProxy"} does not advertise prototype_derive_v1 required by ${fields[0]}. Nothing was shown. Update the connected renderer or use literal rows.`;
}

/** A field source is the explicit opt-in to a nested repeat. */
export function prototypeNestedRepeatFields(spec: unknown): string[] {
  const fields: string[] = [];
  const pending = prototypeSpecNodeRoots(spec);
  while (pending.length) {
    const { node, path } = pending.pop()!;
    const value = record(node);
    if (!value) {
      continue;
    }
    if (Object.hasOwn(record(record(value.repeat)?.items) ?? {}, "field")) {
      fields.push(`${path}.repeat.items.field`);
    }
    pending.push(
      ...prototypeNodeChildren(value).map((child) => ({
        node: child.value,
        path: `${path}${child.suffix}`,
      })),
    );
  }
  return fields;
}
export function prototypeNestedRepeatUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return `The connected ${platform} renderer does not advertise prototype_nested_repeat_v1 required by ${fields[0]}. Nothing was shown. Update the renderer or remove the inner repeat.`;
}
