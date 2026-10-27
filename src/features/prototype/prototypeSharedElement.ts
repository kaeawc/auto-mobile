import {
  PROTOTYPE_REDUCED_MOTION_CAPABILITY,
  PROTOTYPE_SHARED_ELEMENT_CAPABILITY,
  PROTOTYPE_SHARED_ELEMENT_V2_CAPABILITY,
} from "../observe/android/ctrlProxyProtocol";
import { fail, type Located, type PrototypeValidationError } from "./prototypeBindingValidation";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
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
}

function sharedKeys(
  node: Located,
  nodes: Located[],
  data: PrototypeRepeatData,
): string[] | PrototypeValidationError {
  const shared = record(node.value.shared);
  const key = shared?.key ?? node.value.sharedKey;
  if (typeof key !== "string") return [];
  const at = `${node.path}.${shared ? "shared.key" : "sharedKey"}`;
  const parent = nodes.findLast(
    ({ value, path }) =>
      value.repeat !== undefined && (node.path === path || node.path.startsWith(`${path}.`)),
  );
  if (!shared && parent) return fail(at, "sharedKey is not allowed inside repeat templates");
  if (!key.includes("{")) {
    if (shared && !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$(?![\s\S])/.test(key))
      return fail(at, "Invalid shared key value");
    return parent && node.path !== parent.path
      ? fail(at, "shared key inside repeat requires a key template")
      : [key];
  }
  const repeat = record(parent?.value.repeat);
  if (!repeat || parent?.path === node.path || typeof repeat.key !== "string") {
    return fail(at, "shared key template requires repeat.key");
  }
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
  if (keys.some((value) => !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$(?![\s\S])/.test(value)))
    return fail(at, "Invalid resolved shared key value");
  if (new Set(keys).size !== keys.length)
    return fail(at, "shared key resolves to multiple nodes on the same side");
  return keys;
}

/** Contract pre-order; native validators preserve this first-error ordering. */
export function prototypeSharedElementError(
  nodes: Located[],
  data: PrototypeRepeatData,
): PrototypeValidationError | undefined {
  const pairs = new Map<string, SharedOccurrence[]>();
  for (const located of nodes) {
    const { value: node, path } = located;
    const shared = record(node.shared);
    if (shared === undefined && node.sharedKey === undefined) continue;
    const at = `${path}.${shared ? "shared.key" : "sharedKey"}`;
    if (shared && node.sharedKey !== undefined)
      return fail(`${path}.shared`, "shared and sharedKey cannot both be set");
    if (node.visibleWhen === undefined)
      return fail(at, "sharedKey requires visibleWhen on the same node");
    const keys = sharedKeys(located, nodes, data);
    if (!Array.isArray(keys)) return keys;
    const boundary = nodes
      .filter(
        ({ value, path: ancestor }) =>
          (value.type === "dialog" || value.type === "bottomSheet") &&
          (path === ancestor || path.startsWith(`${ancestor}.`)),
      )
      .map(({ path: ancestor }) => ancestor)
      .join("/");
    for (const key of keys) {
      const prior = pairs.get(key) ?? [];
      pairs.set(key, prior);
      if (pairs.size > 16) return fail(at, "a spec allows at most 16 sharedKey values");
      if (prior.length === 2)
        return fail(at, `sharedKey "${key}" must be used by exactly two nodes`);
      if (prior.some((entry) => path.startsWith(`${entry.path}.`)))
        return fail(at, "sharedKey nodes cannot be nested in each other");
      if (prior.some((entry) => entry.boundary !== boundary))
        return fail(at, "shared pair cannot cross a dialog or bottomSheet boundary");
      const kind = shared?.as ?? "bounds";
      if (prior.some((entry) => entry.kind !== kind))
        return fail(at, "shared pair must use the same as value");
      prior.push({ path, at, boundary, kind, templated: String(shared?.key).includes("{") });
    }
  }
  for (const [key, entries] of pairs) {
    if (entries.length !== 2 && !entries[0].templated)
      return fail(entries[0].at, `sharedKey "${key}" must be used by exactly two nodes`);
  }
  return undefined;
}

export function prototypeSharedElementV2Fields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.shared !== undefined) fields.push(`${path}.shared`);
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
