import { prototypeShareArgumentsError } from "./prototypeShare";
import { prototypePlatformCall, prototypePlatformUses } from "./prototypePlatform";
import {
  isPrototypeDataPointer,
  prototypeDataPathPointer,
  prototypeDataPlaceholders,
} from "./prototypeData";
import { prototypeShaderFields } from "./prototypeShaders";
import { object, type Located, type PrototypeValidationError } from "./prototypeBindingValidation";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { repeatErrors, repeatFieldReferences, repeatKeyInstances } from "./prototypeRepeat";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import {
  mapBindableFields,
  visitPrototypeHandlerFields,
  type FieldVisitor,
} from "./prototypeTemplate";

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
  const unsupported = unsupportedCapabilitiesError(spec, options);
  if (unsupported) {
    return unsupported;
  }
  const assets = shareAssetsError(spec, options.shareAssetIds);
  if (assets) {
    return assets;
  }
  return options.library ? libraryPolicyError(spec, actions) : undefined;
}

function libraryPolicyError(
  spec: unknown,
  actions: readonly Located[],
): PrototypeValidationError | undefined {
  const window = object(object(spec)?.window);
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
  return hostChannelsError(spec) ?? secureLibraryError(spec) ?? sensitiveLibraryError(spec);
}

/**
 * Sink paths (R2) where a `/data` pointer written by a `sensitive` platform call is bound into a
 * request URL, header, query or body, or a channel URL or header. Every such path is returned in
 * authored order; the library refusal reports the first one, and MCP-direct shows may warn on all.
 */
export function prototypeSensitiveSinkErrors(spec: unknown): PrototypeValidationError[] {
  const tainted = sensitiveDataPointers(spec);
  if (!tainted.length) {
    return [];
  }
  const nodes: { value: Record<string, unknown>; path: string }[] = [];
  walkPrototypeNodes(spec, (value, path) => nodes.push({ value, path }));
  const { requests, fields } = libraryFields(spec, nodes, true);
  fields.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sinkFields = fields.filter(
    // Key fields name state entries, which a `/data` pointer cannot reach.
    (field) => !field.key && requestSinkPath(field.path, requests),
  );
  // Direct warning callers may precede repeat validation. Keep their authored-text scan
  // for invalid repeats; the binder (including the budget probe) requires valid repeats.
  const validRepeats = repeatErrors(spec) === undefined;
  if (validRepeats) {
    const budgetError = secureScanBudgetError(spec, sinkFields);
    if (budgetError) {
      return [budgetError];
    }
  }
  // Typed data pointers stay literal at runtime, even inside repeat rows. Only text binds.
  const located = sinkFields.map((field) => ({
    ...field,
    value: { stateKey: field.dataPointer ? "" : field.text },
  }));
  const instances = validRepeats
    ? repeatKeyInstances(spec, located)
    : located.map((field) => ({ located: field, value: field.value }));
  const texts = new Map<string, string[]>();
  for (const { value, located: field } of instances) {
    const at = texts.get(field.path);
    const text = String(value.stateKey);
    if (at) {
      at.push(text);
    } else {
      texts.set(field.path, [text]);
    }
  }
  // Data-backed rows are rebuilt from live data. Authored row values cannot rule out a read
  // of a sensitive write anywhere in the collection, including rows added after validation.
  const taintedRepeats = nodes.flatMap(({ value, path }) => {
    const repeat = object(value.repeat);
    const pointer = object(repeat?.items)?.path;
    return typeof repeat?.as === "string" &&
      isPrototypeDataPointer(pointer) &&
      tainted.some((taint) => pointersOverlap(taint, pointer, false))
      ? [{ path, alias: repeat.as }]
      : [];
  });
  const errors: PrototypeValidationError[] = [];
  for (const field of sinkFields) {
    const readsTaintedRow = taintedRepeats.some(
      (scope) =>
        field.path.startsWith(`${scope.path}.children[`) &&
        (field.itemBinding ||
          (!field.dataPointer && repeatFieldReferences(field.text, scope.alias).length > 0)),
    );
    // Derived fields have no host-side instances. Retain literal data placeholders in their
    // authored text; the device still resolves those after formatting the derived value.
    const pointers = field.dataPointer
      ? [field.text]
      : (texts.get(field.path) ?? [field.text]).flatMap(prototypeDataPlaceholders);
    const reached =
      readsTaintedRow ||
      pointers.some((pointer) =>
        tainted.some((taint) => pointersOverlap(taint, pointer, !field.dataPointer)),
      );
    if (reached) {
      errors.push({
        path: field.path,
        message: "Sensitive value cannot be bound into a request",
      });
    }
  }
  return errors;
}

export function prototypeSensitiveWarnings(spec: unknown): string[] {
  return prototypeSensitiveSinkErrors(spec).map(
    ({ path, message }) => `${path}: ${message}; ProtoViewer imports of this spec refuse it.`,
  );
}

function sensitiveLibraryError(spec: unknown): PrototypeValidationError | undefined {
  return prototypeSensitiveSinkErrors(spec)[0];
}

/** The `/data` pointers written by `sensitive` calls, in authored order (`into` of each). */
function sensitiveDataPointers(spec: unknown): string[] {
  const pointers: string[] = [];
  for (const use of prototypePlatformUses(spec)) {
    if (use.kind !== "call" || typeof use.action.into !== "string") {
      continue;
    }
    if (!prototypePlatformCall(use.action.call)?.definition.sensitive) {
      continue;
    }
    const pointer = prototypeDataPathPointer(use.action.into);
    if (pointer !== undefined) {
      pointers.push(pointer);
    }
  }
  return pointers;
}

/**
 * Whether two RFC 6901 pointers name overlapping data: one is a segment-wise prefix of the other
 * (a binding of a parent object carries its sensitive member). A `{index}` segment in an `into`
 * path stands for any repeat row, so it matches any segment. Typed sink pointers stay literal;
 * text sinks conservatively retain index matching when a repeat cannot be expanded on the host.
 */
function pointersOverlap(taint: string, pointer: string, pointerIndexWildcard: boolean): boolean {
  const left = taint.slice(1).split("/");
  const right = pointer.slice(1).split("/");
  return left.every(
    (segment, index) =>
      index >= right.length ||
      segment === right[index] ||
      segment === "{index}" ||
      (pointerIndexWildcard && right[index] === "{index}"),
  );
}

/** Request and channel members a value reaches on the wire: url, headers, query and body. */
function requestSinkPath(path: string, requests: readonly string[]): boolean {
  return requests.some(
    (at) =>
      path === `${at}.url` ||
      path === `${at}.body` ||
      path.startsWith(`${at}.body.`) ||
      ["headers", "query"].some(
        (name) => path.startsWith(`${at}.${name}.`) || path.startsWith(`${at}.${name}[`),
      ),
  );
}

function secureScanBudgetError(
  spec: unknown,
  sinkFields: readonly LibraryField[],
): PrototypeValidationError | undefined {
  // Bound work before allocating per-row strings. Charge every sink's authored UTF-8 bytes
  // for every repeat row, including literal spans that the repeat binder would copy.
  const copies = new Map<string, number>();
  for (const { located } of repeatKeyInstances(
    spec,
    sinkFields.map((field) => ({
      ...field,
      value: { stateKey: "{index}" },
    })),
  )) {
    copies.set(located.path, (copies.get(located.path) ?? 0) + 1);
  }
  let expandedBytes = 0;
  for (const field of sinkFields) {
    expandedBytes +=
      Buffer.byteLength(field.text, "utf8") * Math.max(1, copies.get(field.path) ?? 0);
    if (expandedBytes > 4194304) {
      return {
        path: field.path,
        message: "Secure binding scan exceeds 4194304 expanded UTF-8 bytes",
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
  const { requests, fields } = libraryFields(spec, nodes);
  const sharePaths = shareLibraryFields(spec, fields);
  fields.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const inRequest = (path: string) =>
    requests.some(
      (at) =>
        path === `${at}.url` ||
        path.startsWith(`${at}.body.`) ||
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
  const budgetError = secureScanBudgetError(spec, sinkFields);
  if (budgetError) {
    return budgetError;
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
  dataPointer?: boolean;
  itemBinding?: boolean;
}
function libraryFields(
  spec: unknown,
  nodes: readonly Located[],
  includeDataBindings = false,
): { requests: string[]; fields: LibraryField[] } {
  const requests: string[] = [];
  const fields: LibraryField[] = [];
  const collect: FieldVisitor = (raw, at, kind) => {
    if (kind === "request") {
      requests.push(at);
    }
    if (typeof raw === "string" && (kind === "text" || kind === "key")) {
      fields.push({ text: raw, path: at, key: kind === "key" });
    }
    const binding = kind === "emitBinding" ? object(raw) : undefined;
    if (includeDataBindings && binding && !Object.hasOwn(binding, "state")) {
      if (typeof binding.data === "string") {
        fields.push({ text: binding.data, path: at, key: false, dataPointer: true });
      }
      if (typeof binding.item === "string") {
        fields.push({ text: "", path: at, key: false, itemBinding: true });
      }
    }
    return raw;
  };
  for (const { value, path } of nodes) {
    mapBindableFields(value, path, collect);
  }
  visitPrototypeHandlerFields(spec, collect);
  channelFields(spec, requests, fields, collect);
  return { requests, fields };
}

function channelFields(
  spec: unknown,
  requests: string[],
  fields: LibraryField[],
  collect: FieldVisitor,
): void {
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
      } else {
        collect(value, path, "emitBinding");
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

function shareAssetsError(
  spec: unknown,
  ids: readonly string[] | undefined,
): PrototypeValidationError | undefined {
  if (ids === undefined) {
    return undefined;
  }
  const assets = new Set(ids);
  for (const use of prototypePlatformUses(spec)) {
    if (use.kind !== "call" || use.action.call !== "share.open") {
      continue;
    }
    const error = prototypeShareArgumentsError(
      object(use.action.args) ?? {},
      `${use.path}.args`,
      assets,
    );
    if (error) {
      return error;
    }
  }
  return undefined;
}

function shareLibraryFields(spec: unknown, fields: LibraryField[]): Set<string> {
  const paths = new Set<string>();
  for (const use of prototypePlatformUses(spec)) {
    if (use.kind !== "call" || use.action.call !== "share.open") {
      continue;
    }
    for (const [name, binding] of Object.entries(object(use.action.args) ?? {})) {
      addShareBinding(binding, `${use.path}.args.${name}`, fields, paths);
    }
  }
  return paths;
}
function addShareBinding(
  binding: unknown,
  path: string,
  fields: LibraryField[],
  paths: Set<string>,
): void {
  const form = object(binding);
  if (form && Object.hasOwn(form, "value")) {
    shareStrings(form.value, `${path}.value`, fields, paths);
  }
  if (typeof form?.state === "string") {
    fields.push({ text: form.state, path: `${path}.state`, key: true });
  }
}
function shareStrings(
  value: unknown,
  path: string,
  fields: LibraryField[],
  paths: Set<string>,
): void {
  if (typeof value === "string") {
    fields.push({ text: value, path, key: false });
    paths.add(path);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => shareStrings(entry, `${path}[${index}]`, fields, paths));
  } else {
    for (const [key, entry] of Object.entries(object(value) ?? {})) {
      const at = prototypeContractPatterns.pathKey.test(key)
        ? `${path}.${key}`
        : `${path}[${JSON.stringify(key)}]`;
      shareStrings(entry, at, fields, paths);
    }
  }
}
