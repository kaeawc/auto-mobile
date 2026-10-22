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
  const window = object(object(spec)?.window);
  if (options.library) {
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
  fields.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sinkFields = fields.filter(
    (field) =>
      // mapBinding visits only the state key of request/data/emit/platform value bindings.
      (field.key && field.path.endsWith(".state")) ||
      requests.some(
        (at) =>
          field.path === `${at}.url` ||
          field.path === `${at}.body.state` ||
          ["headers", "query"].some(
            (name) =>
              field.path.startsWith(`${at}.${name}.`) || field.path.startsWith(`${at}.${name}[`),
          ),
      ),
  );
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
      return { path: field.path, message: "Secure value cannot be bound into a request" };
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
