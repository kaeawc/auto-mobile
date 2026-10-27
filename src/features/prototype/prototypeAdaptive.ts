import { z } from "zod";
import { stateKeySchema } from "./prototypeActionValues";
import { fail, object, type PrototypeValidationError } from "./prototypeBindingValidation";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import type { PrototypePlatformNote } from "./prototypePlatformNotes";

import { PROTOTYPE_ADAPTIVE_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
export { PROTOTYPE_ADAPTIVE_CAPABILITY };
export interface AdaptiveSlots<Node> {
  list?: Node;
  detail?: Node;
  content?: Node;
  main?: Node;
  supporting?: Node;
}
export function adaptiveChildren<Node extends z.ZodTypeAny>(node: Node) {
  return {
    list: node.optional(),
    detail: node.optional(),
    content: node.optional(),
    main: node.optional(),
    supporting: node.optional(),
  };
}
export const adaptiveSlots = ["list", "detail", "content", "main", "supporting"] as const;
const fieldsByKind: Record<string, readonly string[]> = {
  listDetail: ["list", "detail", "selectionKey"],
  navigationSuite: ["items", "stateKey", "content"],
  supporting: ["main", "supporting", "openKey"],
};

export function buildAdaptiveSchema<C extends z.ZodRawShape>(common: C) {
  return z
    .object({
      ...common,
      type: z.enum(["adaptive"]),
      kind: z.enum(["listDetail", "navigationSuite", "supporting"]),
      selectionKey: stateKeySchema.optional(),
      stateKey: stateKeySchema.optional(),
      openKey: stateKeySchema.optional(),
      items: z
        .array(z.object({ value: z.string(), label: z.string() }).strict())
        .min(1)
        .max(8)
        .optional(),
    })
    .strict();
}

/** Slot and binding checks are shared by show and every state write. Empty selection means list. */
export function prototypeAdaptiveError(
  value: Record<string, unknown>,
  path: string,
  state: Record<string, unknown>,
): PrototypeValidationError | undefined {
  if (value.type !== "adaptive") {
    return undefined;
  }
  const fields = fieldsByKind[String(value.kind)] ?? [];
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      return fail(`${path}.${field}`, "Required field");
    }
  }
  const all = [...adaptiveSlots, "items", "selectionKey", "stateKey", "openKey"];
  for (const field of all) {
    if (Object.hasOwn(value, field) && !fields.includes(field)) {
      return fail(`${path}.${field}`, "Field is not allowed for adaptive kind");
    }
  }
  return adaptiveBindingError(value, path, state);
}

function adaptiveBindingError(
  value: Record<string, unknown>,
  path: string,
  state: Record<string, unknown>,
): PrototypeValidationError | undefined {
  const field =
    value.kind === "supporting"
      ? "openKey"
      : value.kind === "listDetail"
        ? "selectionKey"
        : "stateKey";
  const stored = state[String(value[field])];
  const type = field === "openKey" ? "boolean" : "string";
  if (!Object.hasOwn(state, String(value[field])) || typeof stored !== type) {
    return fail(`${path}.${field}`, `Adaptive ${value.kind} requires a declared ${type} state key`);
  }
  if (value.kind === "navigationSuite") {
    return navigationError(value, path, stored);
  }
  return undefined;
}

function navigationError(
  value: Record<string, unknown>,
  path: string,
  stored: unknown,
): PrototypeValidationError | undefined {
  const values = new Set<unknown>();
  for (const [index, item] of (value.items as unknown[]).entries()) {
    const option = object(item)?.value;
    if (values.has(option)) {
      return fail(`${path}.items[${index}].value`, "Duplicate adaptive item value");
    }
    values.add(option);
  }
  return values.has(stored)
    ? undefined
    : fail(`${path}.stateKey`, "Adaptive navigationSuite state must name an item value");
}

export function prototypeAdaptiveFields(spec: unknown): string[] {
  const paths: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "adaptive") {
      paths.push(path);
    }
  });
  return paths;
}

export function prototypeAdaptiveUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return `The connected ${platform} runtime does not advertise ${PROTOTYPE_ADAPTIVE_CAPABILITY}, so it cannot draw adaptive at ${fields[0]}. Nothing was shown. Update the runtime or remove adaptive nodes.`;
}

export function prototypeAdaptiveNotes(
  spec: unknown,
  platform: "android" | "ios",
): PrototypePlatformNote[] {
  const paths = prototypeAdaptiveFields(spec);
  return paths.length
    ? [
        {
          platform,
          construct: "adaptive",
          effect: "substituted",
          paths: paths.slice(0, 20),
          ...(paths.length > 20 ? { total: paths.length } : {}),
          detail:
            "Adaptive uses native width rules: Android splits panes at expanded and uses a bar/rail/drawer at compact/medium/expanded; iOS horizontalSizeClass regular uses a split/sidebar/inspector and compact a stack/bottom bar/sheet. Breakpoints differ. iOS draws Material-styled containers under every design; native iOS containers are deferred. Compact listDetail back clears selectionKey to an empty string.",
        },
      ]
    : [];
}
