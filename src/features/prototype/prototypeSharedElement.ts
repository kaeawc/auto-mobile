import {
  PROTOTYPE_REDUCED_MOTION_CAPABILITY,
  PROTOTYPE_SHARED_ELEMENT_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import { fail, type Located, type PrototypeValidationError } from "./prototypeBindingValidation";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { prototypeZoomError, prototypeZoomSources } from "./prototypeStackTransitions";
import { record } from "./prototypeTemplate";

export function prototypeReducedMotionFields(spec: unknown): string[] {
  return record(spec)?.motion === "reduced" ? ["motion"] : [];
}

export function prototypeSharedElementFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.sharedKey !== undefined) {
      fields.push(`${path}.sharedKey`);
    }
  });
  return fields;
}

/**
 * Contract node order (pre-order, sorted object fields/screens), after structural validation.
 * Per node: visibility, repeat ancestry, key budget, extra occurrence, nested pair; then lone
 * keys in first-occurrence order. Native validators must preserve this first-error ordering.
 */
export function prototypeSharedElementError(
  nodes: Located[],
  actions: Located[] = [],
): PrototypeValidationError | undefined {
  const sources = prototypeZoomSources(nodes, actions);
  const zoomError = prototypeZoomError(nodes, actions);
  if (zoomError) {
    return zoomError;
  }
  const repeats: string[] = [];
  const pairs = new Map<string, string[]>();
  for (const { value: node, path } of nodes) {
    if (node.repeat !== undefined) {
      repeats.push(path);
    }
    if (typeof node.sharedKey !== "string") {
      continue;
    }
    const at = `${path}.sharedKey`;
    const visibilityError = sharedSourceVisibilityError(node, path, repeats, sources);
    if (visibilityError) {
      return visibilityError;
    }
    const prior = pairs.get(node.sharedKey) ?? [];
    pairs.set(node.sharedKey, prior);
    if (pairs.size > 16) {
      return fail(at, "a spec allows at most 16 sharedKey values");
    }
    if (prior.length === 2) {
      return fail(at, `sharedKey "${node.sharedKey}" must be used by exactly two nodes`);
    }
    if (prior.some((parent) => path.startsWith(`${parent}.`))) {
      return fail(at, "sharedKey nodes cannot be nested in each other");
    }
    prior.push(path);
  }
  return unpairedSharedKeyError(pairs, sources);
}

function sharedSourceVisibilityError(
  node: Record<string, unknown>,
  path: string,
  repeats: string[],
  sources: Set<string>,
): PrototypeValidationError | undefined {
  if (node.visibleWhen === undefined && !sources.has(String(node.sharedKey))) {
    return fail(`${path}.sharedKey`, "sharedKey requires visibleWhen on the same node");
  }
  if (repeats.some((parent) => path === parent || path.startsWith(`${parent}.`))) {
    return fail(`${path}.sharedKey`, "sharedKey is not allowed inside repeat templates");
  }
  return undefined;
}

function unpairedSharedKeyError(
  pairs: Map<string, string[]>,
  sources: Set<string>,
): PrototypeValidationError | undefined {
  for (const [key, paths] of pairs) {
    if (paths.length !== 2 && !sources.has(key)) {
      return fail(`${paths[0]}.sharedKey`, `sharedKey "${key}" must be used by exactly two nodes`);
    }
  }
  return undefined;
}

function unsupportedMessage(
  capability: string,
  feature: string,
  omit: string,
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "ios" ? "connected iOS prototype agent" : "connected CtrlProxy";
  const update =
    platform === "ios"
      ? "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version"
      : "Update the connected CtrlProxy";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${capability}, so it cannot run ${feature} at ${fields[0]}${more}. Nothing was shown. ${update}, or ${omit}.`;
}

export function prototypeReducedMotionUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return unsupportedMessage(
    PROTOTYPE_REDUCED_MOTION_CAPABILITY,
    "reduced motion",
    'use motion: "none" or "standard"',
    fields,
    platform,
  );
}

export function prototypeSharedElementUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return unsupportedMessage(
    PROTOTYPE_SHARED_ELEMENT_CAPABILITY,
    "the shared element",
    "omit sharedKey",
    fields,
    platform,
  );
}
