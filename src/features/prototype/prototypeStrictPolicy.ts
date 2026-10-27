import { prototypeShaderFields } from "./prototypeShaders";
import { object, type Located, type PrototypeValidationError } from "./prototypeBindingValidation";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { repeatKeyInstances } from "./prototypeRepeat";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { mapBindableFields, visitPrototypeHandlerFields } from "./prototypeTemplate";

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
  const unsupported = unsupportedCapabilitiesError(spec, options);
  if (unsupported) {
    return unsupported;
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
    return hostChannelsError(spec) ?? secureLibraryError(spec);
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
  const { requests, fields } = libraryFields(spec, nodes);
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
      (field.key && field.path.endsWith(".state")) || inRequest(field.path),
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

function hostChannelsError(spec: unknown): PrototypeValidationError | undefined {
  const channels = object(object(spec)?.channels) ?? {};
  for (const id of Object.keys(channels).sort()) {
    if (object(channels[id])?.via !== "device") {
      const at = prototypeContractPatterns.pathKey.test(id)
        ? `channels.${id}`
        : `channels[${JSON.stringify(id)}]`;
      return { path: `${at}.via`, message: "Host requests are unavailable in a library" };
    }
  }
  return undefined;
}

interface LibraryField {
  text: string;
  path: string;
  key: boolean;
}
function libraryFields(
  spec: unknown,
  nodes: readonly Located[],
): { requests: string[]; fields: LibraryField[] } {
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
  visitPrototypeHandlerFields(spec, (raw, at, kind) => {
    if (kind === "request") {
      requests.push(at);
    }
    if (typeof raw === "string" && (kind === "text" || kind === "key")) {
      fields.push({ text: raw, path: at, key: kind === "key" });
    }
    return raw;
  });
  channelFields(spec, requests, fields);
  return { requests, fields };
}

function channelFields(spec: unknown, requests: string[], fields: LibraryField[]): void {
  for (const [id, raw] of Object.entries(object(object(spec)?.channels) ?? {})) {
    const channel = object(raw)!;
    const at = prototypeContractPatterns.pathKey.test(id)
      ? `channels.${id}`
      : `channels[${JSON.stringify(id)}]`;
    requests.push(at);
    fields.push({ text: String(channel.url), path: `${at}.url`, key: false });
    for (const [name, value] of Object.entries(object(channel.headers) ?? {})) {
      const path = prototypeContractPatterns.pathKey.test(name)
        ? `${at}.headers.${name}`
        : `${at}.headers[${JSON.stringify(name)}]`;
      if (typeof value === "string") {
        fields.push({ text: value, path, key: false });
      } else if (typeof object(value)?.state === "string") {
        fields.push({ text: String(object(value)!.state), path: `${path}.state`, key: true });
      }
    }
  }
}

function unsupportedCapabilitiesError(
  spec: unknown,
  options: PrototypeStrictOptions,
): PrototypeValidationError | undefined {
  if (options.supportedCapabilities !== undefined && options.requiredCapabilities !== undefined) {
    const missing = options
      .requiredCapabilities(spec)
      .filter((name) => !options.supportedCapabilities?.includes(name));
    if (missing.length) {
      return { path: "$", message: `Unsupported capabilities: ${missing.join(", ")}` };
    }
  }
  return undefined;
}
