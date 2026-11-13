import { prototypeShareArgumentsError } from "./prototypeShare";
import { prototypeMapMarkerAssetsError } from "./prototypeMap";
import {
  prototypePlatformCall,
  prototypePlatformEvent,
  prototypePlatformUses,
  PROTOTYPE_PLATFORM_MODULES,
} from "./prototypePlatform";
import {
  isPrototypeDataPointer,
  prototypeDataPathPointer,
  prototypeDataPlaceholders,
  prototypePlatformPlaceholders,
} from "./prototypeData";
import { parsePrototypeStorageKey } from "./prototypeStorage";
import { prototypeShaderFields } from "./prototypeShaders";
import { object, type Located, type PrototypeValidationError } from "./prototypeBindingValidation";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { repeatErrors, repeatFieldReferences, repeatKeyInstances } from "./prototypeRepeat";
import { stateKeyTaintIndex, stateKeysOverlap } from "./prototypeStateTaint";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import {
  mapBindableFields,
  visitPrototypeHandlerFields,
  type FieldVisitor,
} from "./prototypeTemplate";

export const SECURE_COPY_CHECK_MESSAGE =
  "Secure copy taint analysis exceeds 4000000 overlap checks";
export const SECURE_SCAN_BUDGET_MESSAGE =
  "Secure binding scan exceeds 4194304 expanded UTF-8 bytes";

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
  return (
    hostChannelsError(spec) ??
    secureLibraryError(spec) ??
    sensitiveLibraryError(spec) ??
    sensitiveModuleLibraryError(spec)
  );
}

function sensitiveModuleLibraryError(spec: unknown): PrototypeValidationError | undefined {
  for (const use of prototypePlatformUses(spec)) {
    if (use.kind === "call" && prototypePlatformCall(use.action.call)?.definition.sensitive) {
      return {
        path: use.path,
        message: `Sensitive platform call ${String(use.action.call)} is unavailable in a library`,
      };
    }
    if (use.kind === "handler" && prototypePlatformEvent(use.event)?.definition.sensitive) {
      return {
        path: use.path,
        message: `Sensitive platform event ${use.event} is unavailable in a library`,
      };
    }
  }
  return undefined;
}

/**
 * Sink paths (R2) where sensitive call results or platform state reach request/channel wire
 * fields or storage. The library refusal reports the first sorted path; direct shows warn on all.
 */
export function prototypeSensitiveSinkErrors(spec: unknown): PrototypeValidationError[] {
  return prototypeSensitiveSinkScan(spec).errors;
}

/** Counts sink trie-node visits, excluding construction and copy propagation. */
export function prototypeSensitiveSinkScan(spec: unknown): {
  errors: PrototypeValidationError[];
  checks: number;
} {
  let checks = 0;
  const visit = () => checks <= MAX_COPY_TAINT_CHECKS && ++checks <= MAX_COPY_TAINT_CHECKS;
  const tainted = sensitiveDataPointers(spec);
  const platformTainted = sensitivePlatformPointers(spec);
  if (!tainted.length && !platformTainted.length) {
    return { errors: [], checks };
  }
  const nodes: { value: Record<string, unknown>; path: string }[] = [];
  walkPrototypeNodes(spec, (value, path) => nodes.push({ value, path }));
  const { requests, fields, dataWrites } = libraryFields(spec, nodes, true);
  requests.push(...webViewPaths(nodes));
  const stateTainted: string[] = [];
  if (propagateDataTaint(tainted, platformTainted, dataWrites, { stateTainted }) === undefined) {
    return { errors: [{ path: "$", message: SECURE_COPY_CHECK_MESSAGE }], checks };
  }
  const dataIndex = sinkOverlapIndex(tainted, visit);
  const platformIndex = sinkOverlapIndex(platformTainted, visit);
  const stateIndex = stateKeyTaintIndex(stateTainted, visit);
  const requestPaths = new Set(requests);
  const sinkFields = fields.filter(
    // Key fields name state entries; only a tainted state key makes one a sink.
    (field) => (!field.key || stateTainted.length > 0) && requestSinkPath(field.path, requestPaths),
  );
  sinkFields.push(...sensitiveStorageFields(spec, stateTainted.length > 0));
  sinkFields.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Direct warning callers may precede repeat validation. Keep their authored-text scan
  // for invalid repeats; the binder (including the budget probe) requires valid repeats.
  const validRepeats = repeatErrors(spec) === undefined;
  if (validRepeats) {
    const budgetError = secureScanBudgetError(spec, sinkFields);
    if (budgetError) {
      return { errors: [budgetError], checks };
    }
  }
  // Typed data pointers stay literal at runtime, even inside repeat rows. Only text binds.
  const located = sinkFields.map((field) => ({
    ...field,
    value: { stateKey: field.pointerSource ? "" : field.text },
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
      dataIndex(pointer, false)
      ? [{ path, alias: repeat.as }]
      : [];
  });
  const errors = sinkFields.flatMap((field) => {
    if (checks > MAX_COPY_TAINT_CHECKS) {
      return [];
    }
    const boundTexts = texts.get(field.path) ?? [field.text];
    // A key field reads the named state entry; text interpolates `{key}` state placeholders.
    const readsTaintedState = field.key
      ? boundTexts.some((key) => stateIndex.key(key))
      : !field.pointerSource && boundTexts.some((text) => stateIndex.text(text));
    if (field.key) {
      return readsTaintedState ? [sinkError(field.path)] : [];
    }
    const readsTaintedRow = taintedRepeats.some(
      (scope) =>
        field.path.startsWith(`${scope.path}.children[`) &&
        (field.itemBinding ||
          (!field.pointerSource && repeatFieldReferences(field.text, scope.alias).length > 0)),
    );
    // Derived fields have no host-side instances. Retain literal data placeholders in their
    // authored text; the device still resolves those after formatting the derived value.
    const reaches = (source: "data" | "platform", index: ReturnType<typeof sinkOverlapIndex>) => {
      const pointers = field.pointerSource
        ? field.pointerSource === source
          ? [field.text]
          : []
        : boundTexts.flatMap(
            source === "data" ? prototypeDataPlaceholders : prototypePlatformPlaceholders,
          );
      return pointers.some((pointer) => index(pointer, !field.pointerSource));
    };
    const reached =
      readsTaintedRow ||
      readsTaintedState ||
      reaches("data", dataIndex) ||
      reaches("platform", platformIndex);
    return reached ? [sinkError(field.path)] : [];
  });
  return {
    errors:
      checks > MAX_COPY_TAINT_CHECKS ? [{ path: "$", message: SECURE_COPY_CHECK_MESSAGE }] : errors,
    checks,
  };
}

function sinkError(path: string): PrototypeValidationError {
  return {
    path,
    message: path.startsWith("storage.keys[")
      ? "Sensitive value cannot be persisted"
      : "Sensitive value cannot be bound into a request",
  };
}

interface SinkTaintNode {
  children: Map<string, SinkTaintNode>;
  terminal: boolean;
  hasTaintBelow: boolean;
}

/** Existence index for pointersOverlap's segment-prefix and {index} rules. */
function sinkOverlapIndex(taints: readonly string[], visit: () => boolean) {
  const node = (): SinkTaintNode => ({
    children: new Map(),
    terminal: false,
    hasTaintBelow: false,
  });
  const root = node();
  for (const taint of taints) {
    let at = root;
    at.hasTaintBelow = true;
    for (const segment of pointerSegments(taint)) {
      let child = at.children.get(segment);
      if (!child) {
        child = node();
        at.children.set(segment, child);
      }
      at = child;
      at.hasTaintBelow = true;
    }
    at.terminal = true;
  }
  return (pointer: string, pointerIndexWildcard: boolean): boolean => {
    const segments = pointerSegments(pointer);
    const walk = (at: SinkTaintNode, depth: number): boolean => {
      if (!visit()) {
        return false;
      }
      if (at.terminal || depth === segments.length) {
        return at.hasTaintBelow;
      }
      const segment = segments[depth];
      if (pointerIndexWildcard && segment === "{index}") {
        for (const child of at.children.values()) {
          if (walk(child, depth + 1)) {
            return true;
          }
        }
        return false;
      }
      const literal = at.children.get(segment);
      const wildcard = segment === "{index}" ? undefined : at.children.get("{index}");
      return !!((literal && walk(literal, depth + 1)) || (wildcard && walk(wildcard, depth + 1)));
    };
    return walk(root, 0);
  };
}

function pointerSegments(pointer: string): string[] {
  return pointer.slice(1).split("/");
}

export function prototypeSensitiveWarnings(spec: unknown): string[] {
  return prototypeSensitiveSinkErrors(spec).map(({ path, message }) =>
    message === SECURE_SCAN_BUDGET_MESSAGE
      ? `${path}: sensitive sink analysis stopped at the 4194304 expanded-byte budget at this path, so the sinks in this spec are unchecked and no sink findings are listed; this is a warning only and does not block the show.`
      : message === SECURE_COPY_CHECK_MESSAGE
        ? `${path}: sensitive sink analysis stopped at the 4000000 copy-check limit, so the sinks in this spec are unchecked and no sink findings are listed; this is a warning only and does not block the show.`
        : `${path}: ${message}; this is a warning only and does not block the show.`,
  );
}

/** Overlap checks one copy-taint propagation may spend before it fails closed. */
const MAX_COPY_TAINT_CHECKS = 4_000_000;

/**
 * A data action or `setState` that copies a tainted `/data`, sensitive `/platform` or tainted
 * state read into `/data` or a state key taints its destination, transitively (a copy of a copy
 * stays tainted, including through state). Mutates `tainted` and `stateTainted`; a worklist over
 * copies bucketed by the first segment of their data source (or their literal state key) keeps
 * long chains linear. Returns the overlap checks spent, or undefined when the check cap is
 * exceeded, so callers fail closed. Exported so tests can assert the linear scaling by counting
 * work instead of wall-clock time; `maxChecks` lets them reach the cap without spending it.
 */
export function propagateDataTaint(
  tainted: string[],
  platformTainted: readonly string[],
  writes: readonly DataWrite[],
  { stateTainted = [], maxChecks = MAX_COPY_TAINT_CHECKS }: CopyTaintOptions = {},
): number | undefined {
  const known = new Set(tainted);
  const knownState = new Set(stateTainted);
  const queue = [
    ...tainted.map((at) => ({ state: false, at })),
    ...stateTainted.map((at) => ({ state: true, at })),
  ];
  const mark = (write: DataWrite) => {
    const [seen, list] = write.intoState ? [knownState, stateTainted] : [known, tainted];
    if (!seen.has(write.into)) {
      seen.add(write.into);
      list.push(write.into);
      queue.push({ state: write.intoState === true, at: write.into });
    }
  };
  const sources = bucketWrites(writes);
  let checks = 0;
  for (const write of sources.platform) {
    checks += platformTainted.length;
    if (platformTainted.some((taint) => pointersOverlap(taint, write.from, false))) {
      mark(write);
    }
  }
  const drain = (bucket: DataWrite[], hit: (write: DataWrite) => boolean): DataWrite[] => {
    checks += bucket.length;
    return bucket.filter((write) => {
      if (hit(write)) {
        mark(write);
        return false;
      }
      return true;
    });
  };
  for (let at = 0; at < queue.length; at += 1) {
    const taint = queue[at];
    (taint.state ? drainStateTaint : drainDataTaint)(taint.at, sources, drain);
    if (checks > maxChecks) {
      return undefined;
    }
  }
  return checks <= maxChecks ? checks : undefined;
}

export interface CopyTaintOptions {
  /** Tainted state keys; mutated like `tainted` as copies reach new keys. */
  stateTainted?: string[];
  maxChecks?: number;
}

interface WriteBuckets {
  platform: DataWrite[];
  /** Data reads keyed by the first segment of their source pointer. */
  data: Map<string, DataWrite[]>;
  /** State reads of a literal key, keyed by that key. */
  state: Map<string, DataWrite[]>;
  /** State reads whose key holds a repeat placeholder; any matching taint may reach them. */
  templatedState: DataWrite[];
}

function bucketWrites(writes: readonly DataWrite[]): WriteBuckets {
  const buckets: WriteBuckets = {
    platform: [],
    data: new Map(),
    state: new Map(),
    templatedState: [],
  };
  const add = (map: Map<string, DataWrite[]>, key: string, write: DataWrite) => {
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(write);
    } else {
      map.set(key, [write]);
    }
  };
  for (const write of writes) {
    if (write.source === "platform") {
      buckets.platform.push(write);
    } else if (write.source === "data") {
      add(buckets.data, firstPointerSegment(write.from), write);
    } else if (write.from.includes("{")) {
      buckets.templatedState.push(write);
    } else {
      add(buckets.state, write.from, write);
    }
  }
  return buckets;
}

function drainDataTaint(
  taint: string,
  sources: WriteBuckets,
  drain: (bucket: DataWrite[], hit: (write: DataWrite) => boolean) => DataWrite[],
): void {
  const key = firstPointerSegment(taint);
  // A leading `{index}` taint segment matches any source segment.
  for (const name of key === "{index}" ? [...sources.data.keys()] : [key]) {
    sources.data.set(
      name,
      drain(sources.data.get(name) ?? [], (write) => pointersOverlap(taint, write.from, false)),
    );
  }
}

function drainStateTaint(
  taint: string,
  sources: WriteBuckets,
  drain: (bucket: DataWrite[], hit: (write: DataWrite) => boolean) => DataWrite[],
): void {
  const hit = (write: DataWrite) => stateKeysOverlap(taint, write.from);
  // A templated taint (a key bound per repeat row) may name any literal key sharing its prefix.
  for (const name of taint.includes("{") ? [...sources.state.keys()] : [taint]) {
    const bucket = sources.state.get(name);
    if (bucket) {
      sources.state.set(name, drain(bucket, hit));
    }
  }
  sources.templatedState = drain(sources.templatedState, hit);
}

function firstPointerSegment(pointer: string): string {
  return pointer.slice(1).split("/", 1)[0];
}

function sensitiveLibraryError(spec: unknown): PrototypeValidationError | undefined {
  return prototypeSensitiveSinkErrors(spec)[0];
}

function sensitivePlatformPointers(spec: unknown): string[] {
  const declared = object(object(spec)?.requires)?.platform;
  return Object.entries(PROTOTYPE_PLATFORM_MODULES).flatMap(([module, entry]) =>
    Object.entries(entry.state ?? {}).flatMap(([key, state]) =>
      state.sensitive && Array.isArray(declared) && declared.includes(module)
        ? [`/${module}/${key}`]
        : [],
    ),
  );
}

function sensitiveStorageFields(spec: unknown, includeState: boolean): LibraryField[] {
  const fields: LibraryField[] = [];
  const storageKeys = object(object(spec)?.storage)?.keys;
  if (Array.isArray(storageKeys)) {
    storageKeys.forEach((key, index) => {
      const parsed = parsePrototypeStorageKey(key);
      if (parsed?.kind === "data") {
        fields.push({
          text: parsed.pointer,
          path: `storage.keys[${index}]`,
          key: false,
          pointerSource: "data",
        });
      } else if (parsed?.kind === "state" && includeState) {
        fields.push({ text: parsed.key, path: `storage.keys[${index}]`, key: true });
      }
    });
  }
  return fields;
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
  const left = pointerSegments(taint);
  const right = pointerSegments(pointer);
  return left.every(
    (segment, index) =>
      index >= right.length ||
      segment === right[index] ||
      segment === "{index}" ||
      (pointerIndexWildcard && right[index] === "{index}"),
  );
}

/** A web view loads its url from the page host, so its url is a request sink (#16573, #17194). */
function webViewPaths(nodes: readonly Located[]): string[] {
  return nodes.filter(({ value }) => value.type === "webView").map(({ path }) => path);
}

/** Request and channel members a value reaches on the wire: url, headers, query and body. */
function requestSinkPath(path: string, requests: ReadonlySet<string>): boolean {
  // Check ancestors once rather than comparing every field with every request.
  for (let at = path.indexOf("."); at >= 0; at = path.indexOf(".", at + 1)) {
    if (!requests.has(path.slice(0, at))) {
      continue;
    }
    const member = path.slice(at + 1);
    if (
      member === "url" ||
      member === "body" ||
      member.startsWith("body.") ||
      member.startsWith("headers.") ||
      member.startsWith("headers[") ||
      member.startsWith("query.") ||
      member.startsWith("query[")
    ) {
      return true;
    }
  }
  return false;
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
        message: SECURE_SCAN_BUDGET_MESSAGE,
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
  // A web view loads its url from the page host, so the url is a request sink (#16573).
  requests.push(...webViewPaths(nodes));
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
  pointerSource?: "data" | "platform";
  itemBinding?: boolean;
}
export interface DataWrite {
  /** The `/data` pointer written, or the state key when `intoState` is set. */
  into: string;
  intoState?: true;
  /** `from` is a `/data` pointer, a `/platform` pointer, or a (possibly templated) state key. */
  source: "data" | "platform" | "state";
  from: string;
}

type CopyRead = Pick<DataWrite, "source" | "from">;

/**
 * Pairs a data action's `path` (or a `setState`'s `key`) with its `value` read; both are visited
 * at sibling paths. A `setState` text value is treated as a read of every data or platform
 * placeholder it names and of the enclosing repeat's rows when it references the row alias, so a
 * value the policy cannot prove untainted stays tainted.
 */
class DataCopies {
  private readonly destinations = new Map<string, string>();
  private readonly stateDestinations = new Map<string, string>();
  private readonly reads = new Map<string, CopyRead[]>();
  private readonly stateReads = new Map<string, CopyRead[]>();
  private readonly repeats: { path: string; from: string; alias: string }[];

  constructor(nodes: readonly Located[]) {
    this.repeats = nodes.flatMap(({ value, path }) => {
      const repeat = object(value.repeat);
      const from = object(repeat?.items)?.path;
      return typeof repeat?.as === "string" && isPrototypeDataPointer(from)
        ? [{ path, from, alias: repeat.as }]
        : [];
    });
  }

  visit(raw: unknown, at: string, kind: string): void {
    if (kind === "dataPath" && at.endsWith(".path")) {
      const into = prototypeDataPathPointer(raw);
      if (into !== undefined) {
        this.destinations.set(at.slice(0, -".path".length), into);
      }
    }
    if (kind === "key" && typeof raw === "string") {
      this.visitKey(raw, at);
    }
    if (kind === "operand" && at.endsWith(".value")) {
      this.visitStateValue(raw, at.slice(0, -".value".length));
    }
    if (kind === "emitBinding" && at.endsWith(".value")) {
      this.visitDataValue(object(raw), at);
    }
  }

  writes(): DataWrite[] {
    const pair = (
      reads: Map<string, CopyRead[]>,
      destinations: Map<string, string>,
      target: Pick<DataWrite, "intoState">,
    ): DataWrite[] =>
      [...reads].flatMap(([prefix, list]) => {
        const into = destinations.get(prefix);
        return into === undefined ? [] : list.map((read) => ({ into, ...read, ...target }));
      });
    return [
      ...pair(this.reads, this.destinations, {}),
      ...pair(this.stateReads, this.stateDestinations, { intoState: true }),
    ];
  }

  private visitDataValue(binding: Record<string, unknown> | undefined, at: string): void {
    for (const source of ["data", "platform"] as const) {
      const from = binding?.[source];
      if (typeof from === "string") {
        this.reads.set(at.slice(0, -".value".length), [{ source, from }]);
      }
    }
    if (typeof binding?.item === "string") {
      const scopes = this.scopes(at);
      if (scopes.length > 0) {
        this.reads.set(
          at.slice(0, -".value".length),
          scopes.map(({ from }) => ({ source: "data", from })),
        );
      }
    }
  }

  /** A data action's `{state}` value reads a key; a `setState`'s `key` names its destination. */
  private visitKey(key: string, at: string): void {
    if (at.endsWith(".value.state")) {
      this.reads.set(at.slice(0, -".value.state".length), [{ source: "state", from: key }]);
    } else if (at.endsWith(".key")) {
      this.stateDestinations.set(at.slice(0, -".key".length), key);
    }
  }

  private visitStateValue(raw: unknown, prefix: string): void {
    const platform = object(raw)?.platform;
    const reads: CopyRead[] =
      typeof platform === "string"
        ? [{ source: "platform", from: platform }]
        : typeof raw === "string"
          ? [
              ...prototypeDataPlaceholders(raw).map((from): CopyRead => ({ source: "data", from })),
              ...prototypePlatformPlaceholders(raw).map((from): CopyRead => ({
                source: "platform",
                from,
              })),
              ...this.scopes(prefix)
                .filter(({ alias }) => repeatFieldReferences(raw, alias).length > 0)
                .map(({ from }): CopyRead => ({ source: "data", from })),
            ]
          : [];
    if (reads.length > 0) {
      this.stateReads.set(prefix, reads);
    }
  }

  private scopes(at: string) {
    return this.repeats.filter(({ path }) => at.startsWith(`${path}.children[`));
  }
}

function libraryFields(
  spec: unknown,
  nodes: readonly Located[],
  includeDataBindings = false,
): { requests: string[]; fields: LibraryField[]; dataWrites: DataWrite[] } {
  const requests: string[] = [];
  const fields: LibraryField[] = [];
  const copies = new DataCopies(nodes);
  const collect: FieldVisitor = (raw, at, kind) => {
    copies.visit(raw, at, kind);
    if (kind === "request") {
      requests.push(at);
    }
    if (typeof raw === "string" && (kind === "text" || kind === "key")) {
      fields.push({ text: raw, path: at, key: kind === "key" });
    }
    const binding = kind === "emitBinding" ? object(raw) : undefined;
    if (includeDataBindings && binding && !Object.hasOwn(binding, "state")) {
      for (const source of ["data", "platform"] as const) {
        if (typeof binding[source] === "string") {
          fields.push({ text: binding[source], path: at, key: false, pointerSource: source });
        }
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
  return { requests, fields, dataWrites: copies.writes() };
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
  return prototypeMapMarkerAssetsError(spec, assets);
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
