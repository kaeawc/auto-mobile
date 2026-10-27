import { prototypeShareArgumentsError } from "./prototypeShare";
import { prototypePlatformUses } from "./prototypePlatform";
import { prototypeShaderFields } from "./prototypeShaders";
import { object, type Located, type PrototypeValidationError } from "./prototypeBindingValidation";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { repeatKeyInstances } from "./prototypeRepeat";
import { mapBindableFields } from "./prototypeTemplate";

export interface PrototypeStrictOptions {
  supportedCapabilities?: readonly string[];
  /**
   * Computes the capabilities a spec needs. Injected because the capability gates import the
   * validator's dependencies; importing them here would create a module cycle.
   */
  requiredCapabilities?: (spec: unknown) => readonly string[];
  library?: boolean;
  /** Complete uploaded asset inventory, when statically known. */
  shareAssetIds?: readonly string[];
}

/** Host/device capability negotiation and the additional unprivileged import boundary. */
export function prototypeStrictPolicyError(
  spec: unknown,
  options: PrototypeStrictOptions,
  actions: readonly Located[],
): PrototypeValidationError | undefined {
  if (options.supportedCapabilities !== undefined && options.requiredCapabilities !== undefined) {
    const missing = options
      .requiredCapabilities(spec)
      .filter((name) => !options.supportedCapabilities?.includes(name));
    if (missing.length) {
      return { path: "$", message: `Unsupported capabilities: ${missing.join(", ")}` };
    }
  }
  if (options.shareAssetIds !== undefined)
    for (const use of prototypePlatformUses(spec)) {
      if (use.kind === "call" && use.action.call === "share.open") {
        const error = prototypeShareArgumentsError(
          object(use.action.args) ?? {},
          `${use.path}.args`,
          new Set(options.shareAssetIds),
        );
        if (error) return error;
      }
    }
  const window = object(object(spec)?.window);
  if (options.library) {
    const shader = prototypeShaderFields(spec)[0];
    if (shader) {
      return { path: "$", message: "ProtoViewer bundles refuse custom AGSL shaders" };
    }
    if (window?.layer === "system") {
      return { path: "window.layer", message: "Privileged window layer" };
    }
    if (window?.persistence === "device") {
      return { path: "window.persistence", message: "Privileged window persistence" };
    }
    // Located actions exclude opaque data, request bodies and emit payloads.
    const host = actions.find(({ value }) => value.type === "request" && value.via === "host");
    if (host) {
      return { path: `${host.path}.via`, message: "Host requests are unavailable in a library" };
    }
    return secureLibraryError(spec);
  }
  return undefined;
}

function secureLibraryError(spec: unknown): PrototypeValidationError | undefined {
  const nodes: { value: Record<string, unknown>; path: string }[] = [];
  walkPrototypeNodes(spec, (value, path) => nodes.push({ value, path }));
  const secure = new Set(
    repeatKeyInstances(
      spec,
      nodes
        .filter(
          ({ value }) =>
            value.type === "textField" &&
            (value.secure === true || value.keyboardType === "password"),
        )
        .map(({ value, path }) => ({ value: { stateKey: value.stateKey }, path })),
    )
      .map(({ value }) => value)
      .map((node) => String(node.stateKey)),
  );
  if (!secure.size) {
    return undefined;
  }
  const requests: string[] = [];
  const fields: { text: string; path: string; key: boolean }[] = [];
  for (const { value, path } of nodes) {
    mapBindableFields(value, path, (raw, at, kind) => {
      if (kind === "request") {
        requests.push(at);
      }
      if (typeof raw === "string" && (kind === "text" || kind === "key")) {
        fields.push({ text: raw, path: at, key: kind === "key" });
      }
      return raw;
    });
  }
  const sharePaths = new Set<string>();
  const shareStrings = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      fields.push({ text: value, path, key: false });
      sharePaths.add(path);
    } else if (Array.isArray(value))
      value.forEach((entry, index) => shareStrings(entry, `${path}[${index}]`));
    else if (object(value))
      for (const [key, entry] of Object.entries(object(value)!)) {
        const at = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
          ? `${path}.${key}`
          : `${path}[${JSON.stringify(key)}]`;
        shareStrings(entry, at);
      }
  };
  for (const use of prototypePlatformUses(spec))
    if (use.kind === "call" && use.action.call === "share.open") {
      for (const [name, binding] of Object.entries(object(use.action.args) ?? {})) {
        const form = object(binding);
        if (form && Object.hasOwn(form, "value"))
          shareStrings(form.value, `${use.path}.args.${name}.value`);
        if (typeof form?.state === "string") {
          fields.push({ text: form.state, path: `${use.path}.args.${name}.state`, key: true });
        }
      }
    }
  fields.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const inRequest = (path: string) =>
    requests.some(
      (at) =>
        path === `${at}.url` ||
        path === `${at}.body.state` ||
        ["headers", "query"].some(
          (name) => path.startsWith(`${at}.${name}.`) || path.startsWith(`${at}.${name}[`),
        ),
    );
  const sinkFields = fields.filter(
    (field) =>
      // mapBinding visits only the state key of request/data/emit/platform value bindings.
      (field.key && field.path.endsWith(".state")) ||
      inRequest(field.path) ||
      sharePaths.has(field.path),
  );
  // Bound work before allocating per-row strings. Charge every sink's authored UTF-8 bytes
  // for every repeat row, including literal spans that the repeat binder would copy.
  const copies = new Map<string, number>();
  for (const { located } of repeatKeyInstances(
    spec,
    sinkFields.map((field) => ({
      ...field,
      value: { stateKey: "{index}" },
    })),
  ))
    copies.set(located.path, (copies.get(located.path) ?? 0) + 1);
  let expandedBytes = 0;
  for (const field of sinkFields) {
    expandedBytes +=
      Buffer.byteLength(field.text, "utf8") * Math.max(1, copies.get(field.path) ?? 0);
    if (expandedBytes > 4194304)
      return {
        path: field.path,
        message: "Secure binding scan exceeds 4194304 expanded UTF-8 bytes",
      };
  }
  // Reuse the key binder for text too: repeat substitution has the same string grammar.
  const instances = repeatKeyInstances(
    spec,
    sinkFields.map((field) => ({
      ...field,
      value: { stateKey: field.text },
    })),
  );
  for (const { value, located: field } of instances) {
    const text = String(value.stateKey);
    if (field.key ? secure.has(text) : [...secure].some((key) => text.includes(`{${key}}`))) {
      return {
        path: field.path,
        message: inRequest(field.path)
          ? "Secure value cannot be bound into a request"
          : "Secure value cannot be bound into an action payload",
      };
    }
  }
  const keys = object(object(spec)?.storage)?.keys;
  if (Array.isArray(keys)) {
    const index = keys.findIndex(
      (key) => typeof key === "string" && key.startsWith("state:") && secure.has(key.slice(6)),
    );
    if (index >= 0) {
      return { path: `storage.keys[${index}]`, message: "Secure value cannot be persisted" };
    }
  }
  return undefined;
}
