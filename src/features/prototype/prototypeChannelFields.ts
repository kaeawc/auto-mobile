import { prototypeSpecNodeRoots } from "./prototypeNodeChildren";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { record, type Raw } from "./prototypeTemplate";
const atKey = (path: string, key: string): string =>
  prototypeContractPatterns.pathKey.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;

/** Authored gates include components, styleWhen, handlers and nested action lists; literal JSON is opaque. */
export function prototypeRealtimeFields(spec: unknown, device = false): string[] {
  const root = record(spec) ?? {};
  const paths: string[] = [];
  paths.push(...channelDeclarationFields(root, device));
  if (device) {
    return paths;
  }
  const scan = (value: unknown, path: string) => scanRealtimeFields(value, path, paths);
  for (const { node, path } of prototypeSpecNodeRoots(root)) {
    scan(node, path);
  }
  for (const key of ["platform", "channels"]) {
    scan(root[key], key);
  }
  return paths;
}

function scanRealtimeFields(value: unknown, path: string, paths: string[]): void {
  const scan = (child: unknown, at: string) => scanRealtimeFields(child, at, paths);
  if (Array.isArray(value)) {
    value.forEach((child, index) => scan(child, `${path}[${index}]`));
    return;
  }
  const obj = record(value);
  if (!obj || (Object.keys(obj).length === 1 && Object.hasOwn(obj, "value"))) {
    return;
  }
  actionFields(obj, path, paths);
  scanChildren(obj, path, paths);
}

function actionFields(obj: Raw, path: string, paths: string[]): void {
  if (obj.type === "upsertData" || (obj.type === "appendData" && obj.maxItems !== undefined)) {
    paths.push(path);
  }
  const binding = record(obj.value);
  if (
    ["setState", "setData", "appendData", "prependData", "upsertData"].includes(String(obj.type)) &&
    binding &&
    (Object.hasOwn(binding, "event") || Object.hasOwn(binding, "platform"))
  ) {
    paths.push(`${path}.value`);
  }
  wholeEventArgumentFields(obj, path, paths);
}

function wholeEventArgumentFields(obj: Raw, path: string, paths: string[]): void {
  if (obj.type === "platform") {
    for (const [name, arg] of Object.entries(record(obj.args) ?? {})) {
      if (record(arg)?.event === "") {
        paths.push(`${atKey(`${path}.args`, name)}.event`);
      }
    }
  }
}

function scanChildren(obj: Raw, path: string, paths: string[]): void {
  const scan = (child: unknown, at: string) => scanRealtimeFields(child, at, paths);
  for (const key of Object.keys(obj).sort()) {
    if (["data", "state", "payload", "repeat", "value"].includes(key)) {
      continue;
    }
    if (key === "screens" && record(obj[key])) {
      for (const [screen, child] of Object.entries(record(obj[key])!)) {
        scan(child, `${path}.screens[${JSON.stringify(screen)}]`);
      }
    } else {
      scan(obj[key], atKey(path, key));
    }
  }
}

function channelDeclarationFields(root: Raw, device: boolean): string[] {
  const channels = record(root.channels);
  if (!channels) {
    return [];
  }
  if (!device) {
    return ["channels"];
  }
  return Object.keys(channels)
    .sort()
    .filter((id) => record(channels[id])?.via === "device")
    .map((id) => `${atKey("channels", id)}.via`);
}
