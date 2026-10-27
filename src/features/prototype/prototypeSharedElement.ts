import { isPrototypeGlassShared } from "./prototypeGlass";
import {
  PROTOTYPE_REDUCED_MOTION_CAPABILITY,
  PROTOTYPE_SHARED_ELEMENT_CAPABILITY,
  PROTOTYPE_SHARED_ELEMENT_V2_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import { fail, type Located, type PrototypeValidationError } from "./prototypeBindingValidation";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { prototypeZoomError, prototypeZoomSources } from "./prototypeStackTransitions";
import { PrototypeRepeatData } from "./prototypeData";
import { bindText, templateSegments, record } from "./prototypeTemplate";

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

interface SharedOccurrence {
  path: string;
  at: string;
  boundary: string;
  kind: unknown;
  templated: boolean;
  repeatPath?: string;
}

function sharedKeys(
  node: Located,
  nodes: Located[],
  data: PrototypeRepeatData,
): string[] | PrototypeValidationError {
  const shared = record(node.value.shared);
  const key = shared?.key ?? node.value.sharedKey;
  if (typeof key !== "string") {
    return [];
  }
  const at = `${node.path}.${shared ? "shared.key" : "sharedKey"}`;
  const parent = sharedRepeatParent(nodes, node.path);
  if (!shared && parent) {
    return fail(at, "sharedKey is not allowed inside repeat templates");
  }
  if (!key.includes("{")) {
    return literalKeys(
      key,
      shared !== undefined,
      parent !== undefined && node.path !== parent.path,
      at,
    );
  }
  return repeatTemplateKeys(key, parent, node.path, at, data);
}

function repeatTemplateKeys(
  key: string,
  parent: Located | undefined,
  path: string,
  at: string,
  data: PrototypeRepeatData,
): string[] | PrototypeValidationError {
  const repeat = record(parent?.value.repeat);
  if (!repeat || parent?.path === path || typeof repeat.key !== "string") {
    return fail(at, "shared key template requires repeat.key");
  }
  return templateKeys(key, repeat, at, data);
}

function literalKeys(
  key: string,
  shared: boolean,
  inRepeat: boolean,
  at: string,
): string[] | PrototypeValidationError {
  if (shared && !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$(?![\s\S])/.test(key)) {
    return fail(at, "Invalid shared key value");
  }
  return inRepeat ? fail(at, "shared key inside repeat requires a key template") : [key];
}

function templateKeys(
  key: string,
  repeat: Record<string, unknown>,
  at: string,
  data: PrototypeRepeatData,
): string[] | PrototypeValidationError {
  const binding = { alias: String(repeat.as), index: true };
  const segments = templateSegments(key, binding);
  const fields = segments.filter((segment) => segment.kind === "field");
  if (
    !fields.length ||
    segments.some(
      (segment) =>
        segment.kind === "index" ||
        (segment.kind === "field" && segment.name !== repeat.key) ||
        (segment.kind === "literal" && /[{}]/.test(segment.text)),
    )
  ) {
    return fail(at, "shared key template must reference only repeat.key");
  }
  const source = record(repeat.items);
  const items =
    source && typeof source.path === "string"
      ? data.items(source.path)
      : (Array.isArray(repeat.items) ? repeat.items : []).map((item) => record(item) ?? {});
  const keys = items.map((values, index) => bindText(key, { binding, values, index }));
  if (keys.some((value) => !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$(?![\s\S])/.test(value))) {
    return fail(at, "Invalid resolved shared key value");
  }
  if (new Set(keys).size !== keys.length) {
    return fail(at, "shared key resolves to multiple nodes on the same side");
  }
  return keys;
}

/** Contract pre-order; native validators preserve this first-error ordering. */
export function prototypeSharedElementError(
  nodes: Located[],
  data: PrototypeRepeatData,
  actions: Located[] = [],
): PrototypeValidationError | undefined {
  const zoomError = prototypeZoomError(nodes, actions);
  if (zoomError) {
    return zoomError;
  }
  const sources = prototypeZoomSources(nodes, actions);
  const pairs = new Map<string, SharedOccurrence[]>();
  for (const located of nodes) {
    const error = addSharedNode(located, nodes, data, pairs, sources);
    if (error) {
      return error;
    }
  }
  for (const [key, entries] of pairs) {
    if (entries.length !== 2 && !entries[0].templated) {
      return fail(entries[0].at, `sharedKey "${key}" must be used by exactly two nodes`);
    }
  }
  return undefined;
}

function addSharedNode(
  located: Located,
  nodes: Located[],
  data: PrototypeRepeatData,
  pairs: Map<string, SharedOccurrence[]>,
  sources: Set<string>,
): PrototypeValidationError | undefined {
  const { value: node, path } = located;
  const shared = record(node.shared);
  if (shared === undefined && node.sharedKey === undefined) {
    return undefined;
  }
  const at = `${path}.${shared ? "shared.key" : "sharedKey"}`;
  const source = isSharedSource(located, nodes, sources);
  const usage = sharedUsageError(node, path, at, source);
  if (usage) {
    return usage;
  }
  const keys = sharedKeys(located, nodes, data);
  if (!Array.isArray(keys)) {
    return keys;
  }
  if (source) {
    return undefined;
  }
  const entry = sharedOccurrence(located, nodes, shared, at);
  for (const key of keys) {
    const prior = pairs.get(key) ?? [];
    pairs.set(key, prior);
    const error = sharedPairError(key, entry, prior, pairs.size);
    if (error) {
      return error;
    }
    prior.push(entry);
  }
  return undefined;
}

function isSharedSource(located: Located, nodes: Located[], sources: Set<string>): boolean {
  const { value: node, path } = located;
  return (
    sources.has(String(record(node.shared)?.key ?? node.sharedKey)) ||
    isPrototypeGlassShared(node, path, nodes)
  );
}

function sharedUsageError(
  node: Record<string, unknown>,
  path: string,
  at: string,
  source: boolean,
): PrototypeValidationError | undefined {
  if (record(node.shared) && node.sharedKey !== undefined) {
    return fail(`${path}.shared`, "shared and sharedKey cannot both be set");
  }
  if (node.visibleWhen === undefined && !source) {
    return fail(at, "sharedKey requires visibleWhen on the same node");
  }
  return undefined;
}

function sharedRepeatParent(nodes: Located[], path: string): Located | undefined {
  return nodes.findLast(
    ({ value, path: ancestor }) =>
      value.repeat !== undefined && (path === ancestor || path.startsWith(`${ancestor}.`)),
  );
}

function sharedOccurrence(
  located: Located,
  nodes: Located[],
  shared: Record<string, unknown> | undefined,
  at: string,
): SharedOccurrence {
  const { path } = located;
  const parent = sharedRepeatParent(nodes, path);
  return {
    path,
    at,
    boundary: sharedBoundary(nodes, path),
    kind: shared?.as ?? "bounds",
    templated: String(shared?.key).includes("{"),
    repeatPath: parent?.path === path ? undefined : parent?.path,
  };
}

function sharedBoundary(nodes: Located[], path: string): string {
  return nodes
    .filter(
      ({ value, path: ancestor }) =>
        (value.type === "dialog" || value.type === "bottomSheet") &&
        (path === ancestor || path.startsWith(`${ancestor}.`)),
    )
    .map(({ path: ancestor }) => ancestor)
    .join("/");
}

function sharedPairError(
  key: string,
  current: SharedOccurrence,
  prior: SharedOccurrence[],
  count: number,
): PrototypeValidationError | undefined {
  if (count > 16) {
    return fail(current.at, "a spec allows at most 16 sharedKey values");
  }
  if (current.repeatPath && prior.some((entry) => entry.repeatPath === current.repeatPath)) {
    return fail(current.at, "shared key resolves to multiple nodes on the same side");
  }
  if (prior.length === 2) {
    return fail(current.at, `sharedKey "${key}" must be used by exactly two nodes`);
  }
  if (prior.some((entry) => current.path.startsWith(`${entry.path}.`))) {
    return fail(current.at, "sharedKey nodes cannot be nested in each other");
  }
  if (prior.some((entry) => entry.boundary !== current.boundary)) {
    return fail(current.at, "shared pair cannot cross a dialog or bottomSheet boundary");
  }
  if (prior.some((entry) => entry.kind !== current.kind)) {
    return fail(current.at, "shared pair must use the same as value");
  }
  return undefined;
}

export function prototypeSharedElementV2Fields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.shared !== undefined) {
      fields.push(`${path}.shared`);
    }
  });
  return fields;
}

export function prototypeSharedElementV2UnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return unsupportedMessage(
    PROTOTYPE_SHARED_ELEMENT_V2_CAPABILITY,
    "shared element v2",
    "omit shared",
    fields,
    platform,
  );
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
