import { fail, type Located, type PrototypeValidationError } from "./prototypeBindingValidation";
import { routeParamsSchema } from "./prototypeRouteSchema";
import { z } from "zod";
import { PROTOTYPE_STACK_TRANSITIONS_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { mapBindableFields, record } from "./prototypeTemplate";

export const PROTOTYPE_STACK_TRANSITIONS = [
  "platform",
  "slide",
  "fade",
  "none",
  "sharedAxisX",
  "sharedAxisY",
  "fadeThrough",
  "zoom",
] as const;

/** A stack's `transition` and the per-action override on `push` and `replace`. */
export const stackTransitionSchema = z.enum(PROTOTYPE_STACK_TRANSITIONS).optional();

/** The `push` and `replace` actions: a stack, a screen name and an optional transition override. */
export const stackScreenActionSchema = <T extends "push" | "replace">(type: T) =>
  z
    .object({
      type: z.enum([type]),
      stack: z.string().min(1),
      screen: z.string().min(1),
      params: routeParamsSchema.optional(),
      transition: stackTransitionSchema,
      source: z.string().min(1).optional(),
    })
    .strict();

/** Authored stack and navigation-action transition fields, in tree order. */
export function prototypeStackTransitionFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "stack" && node.transition !== undefined) {
      fields.push(`${path}.transition`);
    }
    mapBindableFields(node, path, (entry, at, kind) => {
      if (kind === "stackTransition") {
        fields.push(at);
      }
      return entry;
    });
  });
  return fields;
}

export function prototypeStackTransitionsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_STACK_TRANSITIONS_CAPABILITY}, so it cannot run the stack transition at ${fields[0]}${more}. Nothing was shown. ${update}, or omit transition on stacks and push/replace actions.`;
}

/** Pattern values and source fields require the newer renderer, including covered containers. */
export function prototypeStackPatternFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.type === "stack" && isStackPattern(node.transition)) {
      fields.push(`${path}.transition`);
    }
    mapBindableFields(node, path, (value, at, kind) => {
      if (kind === "stackSource" || (kind === "stackTransition" && isStackPattern(value))) {
        fields.push(at);
      }
      return value;
    });
  });
  return fields;
}

export function isStackPattern(value: unknown): boolean {
  return ["sharedAxisX", "sharedAxisY", "fadeThrough", "zoom"].includes(String(value));
}

export function prototypeStackPatternsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return prototypeStackTransitionsUnsupportedMessage(fields, platform)
    .replaceAll("prototype_stack_transitions_v1", "prototype_stack_patterns_v1")
    .replace("stack transition at", "stack pattern or source at")
    .replace(
      "omit transition on stacks and push/replace actions.",
      "omit source on push/replace actions and use platform, slide, fade or none for transitions.",
    );
}

export function prototypeZoomSources(
  nodes: { value: Record<string, unknown> }[],
  actions: { value: Record<string, unknown> }[],
): Set<string> {
  const stacks = new Map(
    nodes
      .filter(({ value }) => value.type === "stack")
      .map(({ value }) => [value.id, value.transition]),
  );
  return new Set(
    actions
      .filter(
        ({ value }) =>
          ["push", "replace"].includes(String(value.type)) &&
          (value.transition ?? stacks.get(value.stack)) === "zoom",
      )
      .map(({ value }) => value.source)
      .filter((key): key is string => typeof key === "string"),
  );
}

export function prototypeZoomError(
  nodes: Located[],
  actions: Located[],
): PrototypeValidationError | undefined {
  const stacks = new Map(
    nodes
      .filter(({ value }) => value.type === "stack")
      .map(({ value }) => [value.id, value.transition]),
  );
  for (const { value, path } of actions) {
    if (
      ["push", "replace"].includes(String(value.type)) &&
      (value.transition ?? stacks.get(value.stack)) === "zoom" &&
      (typeof value.source !== "string" ||
        value.source.includes("{") ||
        nodes.filter(
          ({ value: node }) => (record(node.shared)?.key ?? node.sharedKey) === value.source,
        ).length !== 1)
    ) {
      return fail(
        `${path}.source`,
        "zoom requires source to resolve to exactly one sharedKey node",
      );
    }
  }
  return undefined;
}
