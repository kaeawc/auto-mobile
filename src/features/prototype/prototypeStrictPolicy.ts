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
    const channel = hostChannelError(spec);
    if (channel) {
      return channel;
    }
    return secureLibraryError(spec);
  }
  return undefined;
}

/** An explicit host channel is refused like an explicit host request (#14261). */
function hostChannelError(spec: unknown): PrototypeValidationError | undefined {
  const hostChannel = Object.entries(object(object(spec)?.channels) ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .find(([, channel]) => object(channel)?.via === "host");
  return hostChannel
    ? {
        path: `channels.${hostChannel[0]}.via`,
        message: "Host channels are unavailable in a library",
      }
    : undefined;
}

/** A secure value bound into a channel's url or headers would reach the server like a request's. */
function channelSecureError(
  spec: unknown,
  secure: ReadonlySet<string>,
): PrototypeValidationError | undefined {
  const channels = object(object(spec)?.channels) ?? {};
  const binds = (raw: unknown): boolean =>
    typeof raw === "string"
      ? [...secure].some((key) => raw.includes(`{${key}}`))
      : typeof object(raw)?.state === "string" && secure.has(object(raw)!.state as string);
  for (const id of Object.keys(channels).sort()) {
    const channel = object(channels[id]) ?? {};
    const at = `channels.${id}`;
    if (binds(channel.url)) {
      return { path: `${at}.url`, message: "Secure value cannot be bound into a request" };
    }
    const headers = object(channel.headers) ?? {};
    const name = Object.keys(headers)
      .sort()
      .find((header) => binds(headers[header]));
    if (name !== undefined) {
      return {
        path: `${at}.headers.${name}${typeof headers[name] === "string" ? "" : ".state"}`,
        message: "Secure value cannot be bound into a request",
      };
    }
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
  const leaked = channelSecureError(spec, secure);
  if (leaked) {
    return leaked;
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
