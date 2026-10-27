import { logger } from "../../utils/logger";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import { prototypeFieldsOfKind } from "./prototypeEmitContext";
import { prototypeHeaderEntriesError, prototypeRequestStatusKeyError } from "./prototypeRequest";
import { record, type Raw } from "./prototypeTemplate";

/**
 * Host-side rules for realtime channels (#14261): the root `channels` block, `upsertData` and
 * `appendData.maxItems`. The contract types their fields; this module adds what it cannot: the
 * URL scheme per kind, forbidden headers, `requires.platform`, the `statusKey` type, `when`
 * forms per kind and decode, which actions a route may run, and `realtime.*` calls naming a
 * declared channel. Reads of `/platform/realtime/<channel>/<key>` are checked with the other
 * platform reads in `prototypePlatform.ts`. The runtimes (#14268, #14269, #14270) are separate.
 */
export interface PrototypeChannelError {
  path: string;
  message: string;
}

/** The platform module a spec with `channels` must list in `requires.platform`. */
export const PROTOTYPE_REALTIME_MODULE = "realtime";

const CHANNEL_HOOKS = ["onOpen", "onClose", "onError"] as const;
const WEBSOCKET_URL = /^wss?:\/\//i;
const SSE_URL = /^https?:\/\//i;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_CHANNEL_HEADER = /^(sec-websocket-|last-event-id$)/i;
/** Actions that would let a frame drive traffic or navigation. */
const REFUSED_IN_ROUTES: Record<string, string> = {
  request: "A request action cannot run from a channel, so a frame cannot trigger traffic loops",
  push: "A navigation action cannot run from a channel",
  pop: "A navigation action cannot run from a channel",
  popToRoot: "A navigation action cannot run from a channel",
  replace: "A navigation action cannot run from a channel",
  setPage: "A navigation action cannot run from a channel",
};

const memberPath = (path: string, name: string): string =>
  prototypeContractPatterns.pathKey.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`;

const sortedKeys = (value: Raw): string[] =>
  Object.keys(value).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

/** The declared channels, keyed by id. */
function channelsOf(spec: Raw): Raw {
  return record(spec.channels) ?? {};
}

function urlError(kind: unknown, url: string): string | undefined {
  const scheme = kind === "websocket" ? WEBSOCKET_URL : SSE_URL;
  const message =
    kind === "websocket"
      ? "A websocket channel url must be an absolute ws or wss URL"
      : "An sse channel url must be an absolute http or https URL";
  if (url.includes("{")) {
    return scheme.test(url) ? undefined : message;
  }
  try {
    const protocol = new URL(url).protocol;
    const allowed = kind === "websocket" ? ["ws:", "wss:"] : ["http:", "https:"];
    return allowed.includes(protocol) ? undefined : message;
  } catch (error) {
    // The parse failure is the finding; the message is what the author sees.
    logger.debug(`channel url ${url} did not parse: ${error}`);
    return message;
  }
}

function headersError(channel: Raw, at: string): PrototypeChannelError | undefined {
  const base = prototypeHeaderEntriesError(channel.headers, at);
  if (base) {
    return base;
  }
  for (const name of Object.keys(record(channel.headers) ?? {})) {
    if (FORBIDDEN_CHANNEL_HEADER.test(name)) {
      return { path: memberPath(`${at}.headers`, name), message: "Forbidden channel header" };
    }
  }
  return undefined;
}

function reconnectError(channel: Raw, at: string): PrototypeChannelError | undefined {
  const reconnect = record(channel.reconnect);
  const initial = typeof reconnect?.initialDelayMs === "number" ? reconnect.initialDelayMs : 500;
  const max = typeof reconnect?.maxDelayMs === "number" ? reconnect.maxDelayMs : 30000;
  return max < initial
    ? { path: `${at}.reconnect.maxDelayMs`, message: "maxDelayMs must be at least initialDelayMs" }
    : undefined;
}

function whenError(channel: Raw, route: Raw, at: string): PrototypeChannelError | undefined {
  const when = record(route.when);
  if (!when) {
    return undefined;
  }
  if (Object.hasOwn(when, "event") && channel.kind !== "sse") {
    return { path: `${at}.when.event`, message: "when.event applies to sse channels only" };
  }
  if (Object.hasOwn(when, "pointer") && channel.decode === "text") {
    return {
      path: `${at}.when.pointer`,
      message: "A pointer condition needs decode json; a text frame has no members",
    };
  }
  return undefined;
}

/** The first refused action in `actions` or the follow-up lists nested in them. */
function refusedActionError(actions: unknown, at: string): PrototypeChannelError | undefined {
  if (!Array.isArray(actions)) {
    return undefined;
  }
  for (const [index, entry] of actions.entries()) {
    const action = record(entry);
    const here = `${at}[${index}]`;
    const type = typeof action?.type === "string" ? action.type : "";
    if (action && Object.hasOwn(REFUSED_IN_ROUTES, type)) {
      return { path: here, message: REFUSED_IN_ROUTES[type]! };
    }
    for (const nested of ["onSuccess", "onError", "actions"]) {
      const found = action ? refusedActionError(action[nested], `${here}.${nested}`) : undefined;
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function protocolsError(channel: Raw, at: string): PrototypeChannelError | undefined {
  const list = Array.isArray(channel.protocols) ? channel.protocols : [];
  const bad = list.findIndex((protocol) => typeof protocol === "string" && !TOKEN.test(protocol));
  return bad >= 0
    ? { path: `${at}.protocols[${bad}]`, message: "Invalid websocket subprotocol" }
    : undefined;
}

function channelError(id: string, channel: Raw, state: Raw): PrototypeChannelError | undefined {
  const at = memberPath("channels", id);
  if (!prototypeContractPatterns.pathKey.test(id)) {
    return { path: at, message: "A channel id is letters, digits and underscores" };
  }
  const url = typeof channel.url === "string" ? urlError(channel.kind, channel.url) : undefined;
  if (url) {
    return { path: `${at}.url`, message: url };
  }
  if (channel.protocols !== undefined && channel.kind !== "websocket") {
    return { path: `${at}.protocols`, message: "protocols apply to websocket channels only" };
  }
  const protocols = protocolsError(channel, at);
  if (protocols) {
    return protocols;
  }
  const status = prototypeRequestStatusKeyError(
    { type: "request", statusKey: channel.statusKey },
    at,
    state,
  );
  return (
    headersError(channel, at) ?? status ?? reconnectError(channel, at) ?? routesError(channel, at)
  );
}

function routesError(channel: Raw, at: string): PrototypeChannelError | undefined {
  const routes = Array.isArray(channel.routes) ? channel.routes : [];
  for (const [index, entry] of routes.entries()) {
    const route = record(entry) ?? {};
    const routeAt = `${at}.routes[${index}]`;
    const found =
      whenError(channel, route, routeAt) ?? refusedActionError(route.actions, `${routeAt}.actions`);
    if (found) {
      return found;
    }
  }
  for (const hook of CHANNEL_HOOKS) {
    const found = refusedActionError(channel[hook], `${at}.${hook}`);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** `realtime.*` calls name a declared channel, and `realtime.send` a websocket one. */
function callError(action: Raw, at: string, channels: Raw): PrototypeChannelError | undefined {
  const call = typeof action.call === "string" ? action.call : "";
  if (action.type !== "platform" || !call.startsWith(`${PROTOTYPE_REALTIME_MODULE}.`)) {
    return undefined;
  }
  const literal = record(record(action.args)?.channel)?.value;
  if (typeof literal !== "string") {
    return undefined;
  }
  const channel = Object.hasOwn(channels, literal) ? record(channels[literal]) : undefined;
  if (!channel) {
    return { path: `${at}.args.channel.value`, message: `Unknown channel ${literal}` };
  }
  return call === "realtime.send" && channel.kind !== "websocket"
    ? { path: `${at}.args.channel.value`, message: "realtime.send needs a websocket channel" }
    : undefined;
}

/**
 * The first channel-related static error in a structurally valid spec: `requires.platform`, then
 * each channel in sorted id order, then the `realtime.*` calls among `actions`.
 */
export function prototypeChannelsError(
  spec: unknown,
  actions: readonly { value: Raw; path: string }[],
): PrototypeChannelError | undefined {
  const root = record(spec) ?? {};
  const channels = channelsOf(root);
  const ids = sortedKeys(channels);
  const declared = record(root.requires)?.platform;
  if (
    ids.length > 0 &&
    !(Array.isArray(declared) && declared.includes(PROTOTYPE_REALTIME_MODULE))
  ) {
    return { path: "channels", message: "channels require realtime in requires.platform" };
  }
  const state = record(root.state) ?? {};
  for (const id of ids) {
    const found = channelError(id, record(channels[id]) ?? {}, state);
    if (found) {
      return found;
    }
  }
  for (const { value, path } of actions) {
    const found = callError(value, path, channels);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** The ids of declared channels with `via: "device"`, as `channels[...]` paths. */
export function prototypeDeviceChannelFields(spec: unknown): string[] {
  const channels = channelsOf(record(spec) ?? {});
  return sortedKeys(channels)
    .filter((id) => record(channels[id])?.via === "device")
    .map((id) => `${memberPath("channels", id)}.via`);
}

/**
 * Authored paths needing the realtime module capability beyond ordinary module uses: the
 * `channels` block, `upsertData` and `appendData.maxItems` (#14261).
 */
export function prototypeRealtimeAdditionFields(spec: unknown): string[] {
  const channels = Object.keys(channelsOf(record(spec) ?? {})).length > 0 ? ["channels"] : [];
  return [...channels, ...prototypeFieldsOfKind(spec, "realtimeData")];
}

export function prototypeRealtimeDeviceUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise prototype_platform_realtime_device_v1, so it cannot open a via "device" channel at ${fields[0]}${more}. Nothing was shown. ${update}, or use via "host", which the host runs.`;
}
