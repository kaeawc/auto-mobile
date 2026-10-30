import { prototypeChannelHandlers } from "./prototypeChannelHandlers";
import {
  prototypeChannelsError,
  prototypeChannelCallError,
  prototypeRealtimeFields,
} from "./prototypeChannels";
import { prototypeLinksArgumentsError } from "./prototypeLinks";
import { prototypeMediaCaptionsError } from "./prototypeMediaCaptions";
import { prototypeMediaQueueError, prototypeMediaQueueFields } from "./prototypeMediaQueue";
import {
  prototypeMediaCallError,
  prototypeMediaError,
  prototypeMediaPlayers,
  prototypeMediaReadValid,
  prototypeVideoPlayerError,
} from "./prototypeMedia";
import { prototypeMapError } from "./prototypeMap";
import { prototypeShareArgumentsError } from "./prototypeShare";
import { prototypeAuthBlockError, prototypeAuthCallError } from "./prototypeAuth";
import { prototypeCommerceBlockError, prototypeCommerceCallError } from "./prototypeCommerce";
import {
  prototypeNotificationsBlockError,
  prototypeNotificationsReadValid,
  prototypeNotificationsCallError,
} from "./prototypeNotifications";
import {
  prototypeSecureStorageEmitError,
  prototypeSecureStorageError,
} from "./prototypeSecureStorage";
import { prototypeLocationBlockError } from "./prototypeLocationBlock";
import { prototypeSensorsBlockError, prototypeSensorUseError } from "./prototypeSensorsBlock";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import contract from "../../../schemas/prototype-spec-contract.json";
import { PROTOTYPE_PLATFORM_CAPABILITY } from "../observe/android/ctrlProxyProtocol";
import { expandPrototypeComponents } from "./prototypeComponents";
import { prototypePlatformPlaceholders } from "./prototypeData";
import { prototypeSpecNodeRoots, walkPrototypeNodes } from "./prototypeNodeChildren";
import { PROTOTYPE_REQUEST_EVENT_NAME, prototypeIntoError } from "./prototypeRequest";
import type { Rule } from "./prototypeBindingValidation";
import { mapBindableFields, record, type Raw } from "./prototypeTemplate";

/**
 * Host-side rules for the platform vocabulary (#14294): the `platform` action, root `requires`,
 * root `platform.on` handlers, `{platform}` reads and the handler-scoped `{event}` binding. The
 * contract types their shapes; this module adds what it cannot: known calls and events from the
 * `platformModules` table, per-call arguments, declared modules and permissions, `{event}` scope,
 * the `into` path and the reserved `prototype_` emit prefix. It also locates every use for the
 * generated capability gates (`prototype_platform_v1` plus one `prototype_platform_<module>_v1`
 * per module). Runtime dispatch lives on the devices (#14295, #14296).
 */

/** Maximum UTF-8 bytes copied to or returned from the clipboard. */
export const MAX_PROTOTYPE_CLIPBOARD_TEXT_BYTES =
  contract.limits.MAX_PROTOTYPE_CLIPBOARD_TEXT_BYTES;

/** The emit-kind event name a finished platform call is reported under. */
export const PROTOTYPE_PLATFORM_EVENT_NAME = "prototype_platform";
/** The emit-kind event name a delivered platform event is reported under. */
export const PROTOTYPE_PLATFORM_DELIVERED_EVENT_NAME = "prototype_platform_event";
/** Authored emit names cannot start with this; the runtime reports its own events under it. */
export const PROTOTYPE_RESERVED_EMIT_PREFIX = "prototype_";
/** Authored `testTag`s cannot start with this; host controls own the namespace (#15120). */
export const PROTOTYPE_RESERVED_TEST_TAG_PREFIX = "automobile-";
/** Typed outcomes a call writes to `<into>__meta.error` and reports in `prototype_platform`. */
export const PROTOTYPE_PLATFORM_ERROR_CODES = [
  "unsupported",
  "unavailable",
  "permission_denied",
  "invalid_args",
  "cancelled",
  "timeout",
  "too_many_in_flight",
  "platform_error",
] as const;
export type PrototypePlatformErrorCode = (typeof PROTOTYPE_PLATFORM_ERROR_CODES)[number];

export interface PrototypePlatformArgument {
  optional: boolean;
  /** The contract rule a literal `{value}` argument must satisfy. */
  value: Rule;
}
export interface PrototypePlatformCall {
  args: Record<string, PrototypePlatformArgument>;
  permissions: string[];
  background: string[];
  /** Calls and events touching personal data, for the threat model (#14293). */
  sensitive: boolean;
  /**
   * A capability the call needs on top of its module's, so a runtime can offer a module but
   * refuse one of its operations (camera recording, media queues).
   */
  capability?: string;
}
/** One key of a module's read-only `/platform/<module>` state (#15245). */
export interface PrototypePlatformStateEntry {
  /** The platforms that report the key; elsewhere it is absent and compares as missing. */
  platforms: string[];
  /** The default contract rule; valueByPlatform overrides it on a named platform. */
  value: Rule;
  /** Platform overrides; portable spec comparisons accept the union with value. */
  valueByPlatform?: Record<string, Rule>;
  /** Android-only ascending lower bounds of the second and later Material classes, in dp. */
  breakpoints?: number[];
}
export interface PrototypePlatformModule {
  capability: string;
  deviceCapability?: string;
  /** A test-only module (`test`) that no production runtime advertises. */
  placeholder?: boolean;
  calls: Record<string, PrototypePlatformCall>;
  /** `debounceMs` coalesces bursts of the event into one delivery. */
  events: Record<string, { sensitive: boolean; debounceMs?: number }>;
  /**
   * The keys `/platform/<module>/<key>` can read. A module without this table (the placeholder
   * `test`) accepts any pointer; one with it refuses a pointer that is not exactly one listed key.
   */
  state?: Record<string, PrototypePlatformStateEntry>;
}

/** The shared `platformModules` table: each module's calls, events and capability. */
export const PROTOTYPE_PLATFORM_MODULES: Record<string, PrototypePlatformModule> =
  contract.platformModules;

export interface PrototypePlatformError {
  path: string;
  message: string;
}

/** Checks a literal argument against its contract rule; supplied by the contract walk. */
export type PrototypePlatformValueCheck = (
  value: unknown,
  rule: Rule,
  path: string,
) => PrototypePlatformError | undefined;

const module = (name: string): PrototypePlatformModule | undefined =>
  Object.hasOwn(PROTOTYPE_PLATFORM_MODULES, name) ? PROTOTYPE_PLATFORM_MODULES[name] : undefined;

/** `<module>.<op>` split at its first dot, or undefined when either side is empty. */
function qualified(name: unknown): { module: string; member: string } | undefined {
  if (typeof name !== "string") {
    return undefined;
  }
  const dot = name.indexOf(".");
  return dot > 0 && dot < name.length - 1
    ? { module: name.slice(0, dot), member: name.slice(dot + 1) }
    : undefined;
}

/** The module and call a `call` string names, when both exist in the table. */
export function prototypePlatformCall(
  call: unknown,
): { module: string; op: string; definition: PrototypePlatformCall } | undefined {
  const name = qualified(call);
  const owner = name && module(name.module);
  const definition =
    owner && Object.hasOwn(owner.calls, name.member) ? owner.calls[name.member] : undefined;
  return name && definition ? { module: name.module, op: name.member, definition } : undefined;
}

/** The module a `<module>.<event>` handler name belongs to, when the event exists. */
export function prototypePlatformEventModule(event: unknown): string | undefined {
  const name = qualified(event);
  const owner = name && module(name.module);
  return name && owner && Object.hasOwn(owner.events, name.member) ? name.module : undefined;
}

/** The state key a `/platform` pointer reads when it is exactly `/<module>/<key>`, else undefined. */
export function prototypePlatformPointerKey(pointer: string): string | undefined {
  const tokens = pointer.slice(1).split("/");
  return tokens.length === 2 && tokens[1]
    ? tokens[1].replaceAll("~1", "/").replaceAll("~0", "~")
    : undefined;
}

/** The module a `/platform` pointer reads: its first segment. */
export function prototypePlatformPointerModule(pointer: string): string {
  const segment = pointer.slice(1).split("/", 1)[0] ?? "";
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

const memberPath = (path: string, name: string): string =>
  prototypeContractPatterns.pathKey.test(name)
    ? path
      ? `${path}.${name}`
      : name
    : `${path || "$"}[${JSON.stringify(name)}]`;

const sortedKeys = (value: Raw): string[] =>
  Object.keys(value).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

/** One platform construct found in a spec, at its path. */
export type PrototypePlatformUse =
  | { kind: "requires"; path: string }
  | { kind: "declared"; path: string; module: string }
  | { kind: "node"; path: string; module: string }
  | { kind: "handlers"; path: string }
  | { kind: "handler"; path: string; event: string }
  | { kind: "call"; path: string; action: Raw }
  | { kind: "read"; path: string; pointer: string; condition?: Raw }
  | { kind: "event"; path: string; inHandler: boolean };

// Opaque JSON: an emit payload, literal repeat items and a literal binding's value are data.
const OPAQUE_KEYS = new Set(["payload", "repeat"]);

/** The constructs `object` is itself: a call, a `{platform}` read or an `{event}` binding. */
function ownUses(object: Raw, path: string, inHandler: boolean, uses: PrototypePlatformUse[]) {
  if (object.type === "pasteButton") {
    uses.push({
      kind: "call",
      path,
      action: { type: "platform", call: "clipboard.paste", into: object.into },
    });
  }
  if (object.type === "platform" && typeof object.call === "string") {
    uses.push({ kind: "call", path, action: object });
  }
  if (object.type !== undefined) {
    return;
  }
  if (typeof object.platform === "string") {
    uses.push({
      kind: "read",
      path: `${path}.platform`,
      pointer: object.platform,
      condition: object,
    });
  }
  if (typeof object.event === "string") {
    uses.push({ kind: "event", path: `${path}.event`, inHandler });
  }
}

/** Members in sorted order; stack screens are named in brackets, as the screen-map walk does. */
function scanMembers(object: Raw, path: string, inHandler: boolean, uses: PrototypePlatformUse[]) {
  for (const key of sortedKeys(object)) {
    const screens = key === "screens" ? record(object.screens) : undefined;
    if (screens) {
      for (const name of sortedKeys(screens)) {
        scanValue(screens[name], `${path}.screens[${JSON.stringify(name)}]`, inHandler, uses);
      }
    } else if (!OPAQUE_KEYS.has(key)) {
      scanValue(object[key], memberPath(path, key), inHandler, uses);
    }
  }
}

/** Deep scan of nodes and actions for platform calls, `{platform}` reads and `{event}` bindings. */
function scanValue(value: unknown, path: string, inHandler: boolean, uses: PrototypePlatformUse[]) {
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanValue(child, `${path}[${index}]`, inHandler, uses));
    return;
  }
  const object = record(value);
  // A `{value}` binding's literal is opaque data.
  if (!object || (Object.keys(object).length === 1 && Object.hasOwn(object, "value"))) {
    return;
  }
  ownUses(object, path, inHandler, uses);
  scanMembers(object, path, inHandler, uses);
}

/** `{platform:/pointer}` placeholders in every text-kind field of every node. */
function placeholderUses(spec: unknown, uses: PrototypePlatformUse[]) {
  walkPrototypeNodes(spec, (node, path) => {
    mapBindableFields(node, path, (value, at, kind) => {
      if (kind === "text" && typeof value === "string") {
        for (const pointer of prototypePlatformPlaceholders(value)) {
          uses.push({ kind: "read", path: at, pointer });
        }
      }
      return value;
    });
  });
}

/** Every platform construct in `spec`, at the paths of `spec` itself (no component expansion). */
export function prototypePlatformUses(spec: unknown): PrototypePlatformUse[] {
  const root = record(spec);
  if (!root) {
    return [];
  }
  const uses: PrototypePlatformUse[] = [];
  const requires = record(root.requires);
  if (requires) {
    uses.push({ kind: "requires", path: "requires" });
    const declared = Array.isArray(requires.platform) ? requires.platform : [];
    declared.forEach((name, index) => {
      if (typeof name === "string") {
        uses.push({ kind: "declared", path: `requires.platform[${index}]`, module: name });
      }
    });
  }
  const handlers = record(record(root.platform)?.on);
  if (record(root.platform)) {
    uses.push({ kind: "handlers", path: "platform" });
  }
  for (const event of handlers ? sortedKeys(handlers) : []) {
    const at = `platform.on[${JSON.stringify(event)}]`;
    uses.push({ kind: "handler", path: at, event });
    scanValue(handlers![event], at, true, uses);
  }
  for (const handler of prototypeChannelHandlers(root)) {
    scanValue(handler.value, handler.path, true, uses);
  }
  for (const { node, path } of prototypeSpecNodeRoots(root)) {
    scanValue(node, path, false, uses);
  }
  placeholderUses(root, uses);
  // A map node draws through the map module (#14309), so its gate names the node. Only node
  // positions count: a map-shaped value in a request field or payload is data.
  walkPrototypeNodes(root, (node, path) => {
    if (node.type === "map") {
      uses.push({ kind: "node", path, module: "map" });
    }
  });
  return uses;
}

const notDeclared = (path: string, name: string): PrototypePlatformError => ({
  path,
  message: `Platform module ${name} is not declared in requires.platform`,
});

function requiresError(spec: Raw): PrototypePlatformError | undefined {
  const requires = record(spec.requires) ?? {};
  const declared = Array.isArray(requires.platform) ? requires.platform : [];
  for (const [index, name] of declared.entries()) {
    if (typeof name === "string" && !module(name)) {
      return { path: `requires.platform[${index}]`, message: "Unknown platform module" };
    }
  }
  const permissions = Array.isArray(requires.permissions) ? requires.permissions : [];
  const seen = new Set<unknown>();
  for (const [index, permission] of permissions.entries()) {
    const name = record(permission)?.name;
    if (seen.has(name)) {
      return { path: `requires.permissions[${index}].name`, message: "Duplicate permission" };
    }
    seen.add(name);
  }
  return undefined;
}

function argumentsError(
  action: Raw,
  path: string,
  definition: PrototypePlatformCall,
  check: PrototypePlatformValueCheck,
): PrototypePlatformError | undefined {
  const args = record(action.args) ?? {};
  for (const name of sortedKeys({ ...definition.args, ...args })) {
    const at = memberPath(`${path}.args`, name);
    const declared = Object.hasOwn(definition.args, name) ? definition.args[name] : undefined;
    if (!declared) {
      return {
        path: at,
        message:
          action.call === "share.open" && name === "title"
            ? "Unknown argument: use subject"
            : "Unknown argument",
      };
    }
    if (!Object.hasOwn(args, name)) {
      if (!declared.optional) {
        return { path: at, message: "Required argument" };
      }
      continue;
    }
    const error = argumentValueError(action, name, args[name], at, declared.value, check);
    if (error) {
      return error;
    }
  }
  return undefined;
}

/** What a spec declares that platform uses are checked against. */
interface PlatformContext {
  declared: Set<string>;
  permissions: Set<string>;
  background: Set<string>;
  channels: Raw;
  players: ReadonlySet<string>;
  root: Raw;
}

function callError(
  action: Raw,
  path: string,
  context: PlatformContext,
  check: PrototypePlatformValueCheck,
): PrototypePlatformError | undefined {
  const call = prototypePlatformCall(action.call);
  if (!call) {
    return { path: `${path}.call`, message: "Unknown platform call" };
  }
  if (!context.declared.has(call.module)) {
    return notDeclared(`${path}.call`, call.module);
  }
  const permission = call.definition.permissions.find((name) => !context.permissions.has(name));
  if (permission !== undefined) {
    return {
      path: `${path}.call`,
      message: `Platform call ${String(action.call)} requires permission ${permission} in requires.permissions`,
    };
  }
  const background = call.definition.background.find((name) => !context.background.has(name));
  if (background !== undefined) {
    return {
      path: `${path}.call`,
      message: `Platform call ${String(action.call)} requires ${background} in requires.background`,
    };
  }
  const args = argumentsError(action, path, call.definition, check);
  if (args) {
    return args;
  }
  const crossArgs = crossArgumentsError(action, path);
  if (crossArgs) {
    return crossArgs;
  }
  const into = typeof action.into === "string" ? intoError(action.into) : undefined;
  return into ? { path: `${path}.into`, message: into } : undefined;
}

/** Rules that relate one call's arguments to each other, beyond the per-argument contract table. */
const crossArgumentRules: Record<
  string,
  (args: Raw, path: string) => PrototypePlatformError | undefined
> = {
  "share.open": (args, path) => prototypeShareArgumentsError(args, path),
  "links.open": prototypeLinksArgumentsError,
};

function crossArgumentsError(action: Raw, path: string): PrototypePlatformError | undefined {
  const rule =
    typeof action.call === "string" && Object.hasOwn(crossArgumentRules, action.call)
      ? crossArgumentRules[action.call]
      : undefined;
  return rule?.(record(action.args) ?? {}, `${path}.args`);
}

function intoError(into: string): string | undefined {
  return into === "/platform" || into.startsWith("/platform/")
    ? "/platform is read-only: write a platform call result into /data"
    : prototypeIntoError(into, "platform");
}

function strings(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []);
}

function readError(
  use: { path: string; pointer: string },
  {
    declared,
    channels,
    players,
    root,
  }: Pick<PlatformContext, "declared" | "channels" | "players" | "root">,
): PrototypePlatformError | undefined {
  const name = prototypePlatformPointerModule(use.pointer);
  if (!module(name)) {
    return { path: use.path, message: `Unknown platform module ${name}` };
  }
  if (!declared.has(name)) {
    return notDeclared(use.path, name);
  }
  if (!stateKnown(name, use.pointer, { channels, players, root })) {
    return { path: use.path, message: `Unknown platform state ${use.pointer}` };
  }
  const key = prototypePlatformPointerKey(use.pointer);
  return name === "sensors" && key ? prototypeSensorUseError(key, use.path, root) : undefined;
}

/**
 * Whether a declared module's read names one of its state keys: realtime keys sit under a
 * declared channel and media keys under a declared player; a module without a table reads anything.
 */
function stateKnown(
  name: string,
  pointer: string,
  { channels, players, root }: Pick<PlatformContext, "channels" | "players" | "root">,
): boolean {
  const state = module(name)?.state;
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (name === "media") {
    return prototypeMediaReadValid(tokens, players, state ?? {});
  }
  if (name === "notifications") {
    return prototypeNotificationsReadValid(tokens, root, state ?? {});
  }
  if (name === "realtime") {
    return (
      tokens.length === 3 &&
      Object.hasOwn(channels, tokens[1]) &&
      (!state || Object.hasOwn(state, tokens[2]))
    );
  }
  const key = prototypePlatformPointerKey(pointer);
  return !state || (key !== undefined && Object.hasOwn(state, key));
}

/** Check portable comparisons against the union of platform-native state rules. */
function comparisonError(
  use: Extract<PrototypePlatformUse, { kind: "read" }>,
  check: PrototypePlatformValueCheck,
): PrototypePlatformError | undefined {
  const entry = module(prototypePlatformPointerModule(use.pointer))?.state?.[
    prototypePlatformPointerKey(use.pointer) ?? ""
  ];
  // Specs have no target platform and can branch on device.os: accept every native rule.
  if (!entry?.valueByPlatform || !use.condition) {
    return undefined;
  }
  const rule: Rule = {
    kind: "choice",
    options: [entry.value, ...Object.values(entry.valueByPlatform)],
  };
  for (const op of ["equals", "notEquals"]) {
    if (Object.hasOwn(use.condition, op)) {
      const found = check(use.condition[op], rule, use.path.replace(/\.platform$/, `.${op}`));
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function useError(
  use: PrototypePlatformUse,
  context: PlatformContext,
  check: PrototypePlatformValueCheck,
): PrototypePlatformError | undefined {
  switch (use.kind) {
    case "handler": {
      const owner = prototypePlatformEventModule(use.event);
      if (!owner) {
        return { path: use.path, message: "Unknown platform event" };
      }
      if (!context.declared.has(owner)) {
        return notDeclared(use.path, owner);
      }
      return owner === "sensors"
        ? prototypeSensorUseError(use.event.slice("sensors.".length), use.path, context.root)
        : undefined;
    }
    case "call":
      return callError(use.action, use.path, context, check);
    case "read":
      return readError(use, context) ?? comparisonError(use, check);
    case "event":
      return use.inHandler
        ? undefined
        : { path: use.path, message: "{event} is only available inside a platform.on handler" };
    default:
      return undefined;
  }
}

/** A reserved emit name: `prototype_request` keeps its own message (prototypeRequest.ts). */
function emitNameError(action: Raw, path: string): PrototypePlatformError | undefined {
  return action.type === "emit" &&
    typeof action.name === "string" &&
    action.name !== PROTOTYPE_REQUEST_EVENT_NAME &&
    action.name.startsWith(PROTOTYPE_RESERVED_EMIT_PREFIX)
    ? {
        path: `${path}.name`,
        message: `Emit names starting with ${PROTOTYPE_RESERVED_EMIT_PREFIX} are reserved for runtime events`,
      }
    : undefined;
}

/** The first authored node whose `testTag` takes the host-reserved `automobile-` namespace. */
export function prototypeReservedTestTagError(
  nodes: readonly { value: Raw; path: string }[],
): PrototypePlatformError | undefined {
  const node = nodes.find(
    ({ value }) =>
      typeof value.testTag === "string" &&
      value.testTag.startsWith(PROTOTYPE_RESERVED_TEST_TAG_PREFIX),
  );
  return node === undefined
    ? undefined
    : {
        path: `${node.path}.testTag`,
        message: `testTag values starting with ${PROTOTYPE_RESERVED_TEST_TAG_PREFIX} are reserved for host controls`,
      };
}

function platformContext(root: Raw): PlatformContext {
  const requires = record(root.requires) ?? {};
  return {
    channels: record(root.channels) ?? {},
    players: prototypeMediaPlayers(root),
    root,
    declared: strings(requires.platform),
    permissions: new Set(
      (Array.isArray(requires.permissions) ? requires.permissions : []).map(
        (permission) => record(permission)?.name as string,
      ),
    ),
    background: strings(requires.background),
  };
}

/**
 * The first platform-vocabulary error in a structurally valid spec: `requires`, then handlers,
 * calls, reads and `{event}` bindings in scan order, then reserved emit names among `actions`.
 */
export function prototypePlatformError(
  spec: unknown,
  actions: readonly { value: Raw; path: string }[],
  check: PrototypePlatformValueCheck,
): PrototypePlatformError | undefined {
  const root = record(spec) ?? {};
  const context = platformContext(root);
  const error = rootBlockError(root, check);
  if (error) {
    return error;
  }
  for (const use of prototypePlatformUses(root)) {
    const found = useError(use, context, check) ?? channelUseError(use, root, context.players);
    if (found) {
      return found;
    }
  }
  for (const { value, path } of actions) {
    const found = emitNameError(value, path) ?? prototypeSecureStorageEmitError(value, path, root);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * The root-level checks, in order: realtime channels, the auth, commerce, secure storage, location,
 * sensors and notifications blocks, media players and nodes, then `requires`. Kotlin's
 * `rootChecks` keeps the same order.
 */
const ROOT_BLOCK_CHECKS: readonly ((
  root: Raw,
  check: PrototypePlatformValueCheck,
) => PrototypePlatformError | undefined)[] = [
  prototypeChannelsError,
  prototypeAuthBlockError,
  prototypeCommerceBlockError,
  prototypeSecureStorageError,
  prototypeLocationBlockError,
  prototypeSensorsBlockError,
  prototypeNotificationsBlockError,
  prototypeMediaError,
  prototypeMediaQueueError,
  prototypeVideoPlayerError,
  prototypeMapError,
  prototypeMediaCaptionsError,
  requiresError,
];

/** The first error in the root-level blocks. */
function rootBlockError(
  root: Raw,
  check: PrototypePlatformValueCheck,
): PrototypePlatformError | undefined {
  for (const rootCheck of ROOT_BLOCK_CHECKS) {
    const error = rootCheck(root, check);
    if (error) {
      return error;
    }
  }
  return undefined;
}

/** The modules a use needs: its own for calls, handlers, reads and declarations. */
function usedModule(use: PrototypePlatformUse): string | undefined {
  switch (use.kind) {
    case "declared":
    case "node":
      return use.module;
    case "handler":
      return prototypePlatformEventModule(use.event);
    case "call":
      return prototypePlatformCall(use.action.call)?.module;
    case "read":
      return prototypePlatformPointerModule(use.pointer);
    default:
      return undefined;
  }
}

/**
 * Uses at authored paths: the expanded tree's uses located back through component expansion,
 * then the component definitions no expansion visited (the `prototypeFieldsOfKind` order).
 */
function authoredUses(spec: unknown): PrototypePlatformUse[] {
  const authored = prototypePlatformUses(spec);
  const expansion = expandPrototypeComponents(spec);
  if (!expansion.success || !expansion.expanded) {
    return authored;
  }
  const located = prototypePlatformUses(expansion.spec).map((use) => ({
    ...use,
    path: expansion.locate(use.path),
  }));
  const paths = new Set(located.map((use) => use.path));
  return [
    ...located,
    ...authored.filter(
      (use) => !paths.has(use.path) && !located.some((at) => at.path.endsWith(` → ${use.path}`)),
    ),
  ];
}

const unique = (paths: string[]): string[] => [...new Set(paths)];

/** Authored paths needing `prototype_platform_v1`: every platform construct. */
export function prototypePlatformFields(spec: unknown): string[] {
  return unique(authoredUses(spec).map((use) => use.path));
}

/** Authored paths needing one module's capability. */
export function prototypePlatformModuleFields(spec: unknown, name: string): string[] {
  return unique(
    [
      ...(name === "realtime"
        ? prototypeRealtimeFields(spec).map((path) => ({
            kind: "declared" as const,
            path,
            module: name,
          }))
        : []),
      ...authoredUses(spec),
    ]
      .filter((use) => usedModule(use) === name)
      .map((use) => use.path),
  );
}

function unsupported(
  fields: readonly string[],
  platform: "android" | "ios",
  capability: string,
  what: string,
): string {
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${capability}, so it cannot run ${what} at ${fields[0]}${more}. Nothing was shown. ${update}, or use a spec without it.`;
}

export function prototypePlatformUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return unsupported(fields, platform, PROTOTYPE_PLATFORM_CAPABILITY, "the platform vocabulary");
}

/** Authored paths of calls whose definition names `capability` on top of its module's. */
export function prototypePlatformCallCapabilityFields(spec: unknown, capability: string): string[] {
  return unique(
    authoredUses(spec)
      .filter(
        (use) =>
          use.kind === "call" &&
          prototypePlatformCall(use.action.call)?.definition.capability === capability,
      )
      .map((use) => use.path),
  );
}

/** The per-call capabilities in module order, each with the calls that need it. */
const callCapabilities = (): { capability: string; calls: string[] }[] => {
  const byCapability = new Map<string, string[]>();
  for (const [name, definition] of Object.entries(PROTOTYPE_PLATFORM_MODULES)) {
    for (const [op, call] of Object.entries(definition.calls)) {
      if (call.capability) {
        byCapability.set(call.capability, [
          ...(byCapability.get(call.capability) ?? []),
          `${name}.${op}`,
        ]);
      }
    }
  }
  return [...byCapability].map(([capability, calls]) => ({ capability, calls }));
};

/** Spec fields beyond its calls that a per-call capability also gates: a queued player (#14249). */
const CALL_CAPABILITY_FIELDS: Record<
  string,
  { fields: (spec: unknown) => string[]; name: string }
> = {
  prototype_platform_media_queue_v1: {
    fields: prototypeMediaQueueFields,
    name: "a media player `queue`",
  },
};

/** One generated gate per per-call capability, after the module gates. */
const PROTOTYPE_PLATFORM_CALL_GATES = callCapabilities().map(({ capability, calls }) => ({
  capability,
  fields: (spec: unknown) => [
    ...(CALL_CAPABILITY_FIELDS[capability]?.fields(spec) ?? []),
    ...prototypePlatformCallCapabilityFields(spec, capability),
  ],
  unsupportedMessage: (fields: readonly string[], platform: "android" | "ios") =>
    unsupported(
      fields,
      platform,
      capability,
      [
        ...calls.map((call) => `\`${call}\``),
        ...(CALL_CAPABILITY_FIELDS[capability] ? [CALL_CAPABILITY_FIELDS[capability].name] : []),
      ].join(" or "),
    ),
}));

/** One generated gate per module in the `platformModules` table, then one per call capability. */
const PROTOTYPE_PLATFORM_MODULE_ONLY_GATES = Object.entries(PROTOTYPE_PLATFORM_MODULES).flatMap(
  ([name, definition]) => [
    {
      capability: definition.capability,
      fields: (spec: unknown) => prototypePlatformModuleFields(spec, name),
      unsupportedMessage: (fields: readonly string[], platform: "android" | "ios") =>
        unsupported(fields, platform, definition.capability, `the ${name} platform module`),
    },
    ...(definition.deviceCapability
      ? [
          {
            capability: definition.deviceCapability,
            fields: (spec: unknown) => prototypeRealtimeFields(spec, true),
            unsupportedMessage: (fields: readonly string[], platform: "android" | "ios") =>
              unsupported(
                fields,
                platform,
                definition.deviceCapability!,
                "device realtime channels",
              ),
          },
        ]
      : []),
  ],
);

export const PROTOTYPE_PLATFORM_MODULE_GATES = [
  ...PROTOTYPE_PLATFORM_MODULE_ONLY_GATES,
  ...PROTOTYPE_PLATFORM_CALL_GATES,
];

function argumentValueError(
  action: Raw,
  name: string,
  value: unknown,
  at: string,
  rule: Rule,
  check: PrototypePlatformValueCheck,
): PrototypePlatformError | undefined {
  if (typeof value === "string") {
    if (String(action.call).startsWith("realtime.") && name === "channel") {
      return undefined;
    }
    return { path: at, message: "Invalid union value" };
  }
  const binding = record(value);
  if (binding && Object.hasOwn(binding, "value")) {
    // Share retains its portable string diagnostics; JSON envelopes still use the contract walk.
    const error =
      action.call === "share.open" && rule.kind === "string"
        ? undefined
        : check(binding.value, rule, `${at}.value`);
    if (error) {
      return error;
    }
  }
  return undefined;
}

function channelUseError(
  use: PrototypePlatformUse,
  root: Raw,
  players: ReadonlySet<string>,
): PrototypePlatformError | undefined {
  return use.kind === "call"
    ? (prototypeChannelCallError(use.action, use.path, root) ??
        prototypeAuthCallError(use.action, use.path, root) ??
        prototypeCommerceCallError(use.action, use.path, root) ??
        prototypeNotificationsCallError(use.action, use.path, root) ??
        prototypeMediaCallError(use.action, use.path, players))
    : undefined;
}
