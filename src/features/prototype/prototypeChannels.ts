import { MAX_PROTOTYPE_CHANNEL_SEND_BYTES } from "./prototypeChannelLimits";
export { prototypeRealtimeFields } from "./prototypeChannelFields";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import {
  prototypeRequestEntryError,
  prototypeRequestStatusKeyError,
  prototypeRequestUrlError,
} from "./prototypeRequest";
import { record, type Raw } from "./prototypeTemplate";
import type { PrototypePlatformError } from "./prototypePlatform";

const atKey = (path: string, key: string): string =>
  prototypeContractPatterns.pathKey.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;

/** Reuse request URL semantics after mapping WebSocket schemes to their HTTP equivalents. */
export function prototypeChannelUrlError(channel: Raw): string | undefined {
  const raw = String(channel.url);
  const url = channel.kind === "websocket" ? raw.replace(/^ws(s?):/i, "http$1:") : raw;
  if (channel.kind === "websocket" && !/^wss?:/i.test(raw)) {
    return "A websocket channel url must use ws or wss";
  }
  const schemes = channel.kind === "websocket" ? "ws or wss" : "http or https";
  if (!/^(?:wss?|https?):\/\//i.test(raw)) {
    return raw.includes("{")
      ? `A templated ${channel.kind === "websocket" ? "websocket channel" : "request"} url must start with a literal ${channel.kind === "websocket" ? "ws:// or wss://" : "http:// or https://"}`
      : `A ${channel.kind === "websocket" ? "websocket channel" : "request"} url must be an absolute ${schemes} URL`;
  }
  const error = prototypeRequestUrlError(url);
  return channel.kind === "websocket"
    ? error
        ?.replace("request", "websocket channel")
        .replace("http or https", "ws or wss")
        .replace("http:// or https://", "ws:// or wss://")
    : error;
}

export function prototypeChannelsError(spec: unknown): PrototypePlatformError | undefined {
  const root = record(spec) ?? {};
  const channels = record(root.channels);
  if (!channels) {
    return undefined;
  }
  const requires = record(root.requires);
  if (!Array.isArray(requires?.platform) || !requires.platform.includes("realtime")) {
    return { path: "channels", message: "Channels require realtime in requires.platform" };
  }
  for (const id of Object.keys(channels).sort()) {
    const channel = record(channels[id])!;
    const at = atKey("channels", id);
    const error = channelError(channel, at, root);
    if (error) {
      return error;
    }
  }
  return undefined;
}

function callbackError(value: unknown, path: string): PrototypePlatformError | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const [index, raw] of value.entries()) {
    const action = record(raw)!;
    const at = `${path}[${index}]`;
    if (
      ["request", "push", "replace", "pop", "popToRoot", "dismiss", "setPage"].includes(
        String(action.type),
      ) ||
      (action.type === "platform" && action.call === "realtime.connect")
    ) {
      return {
        path: `${at}.${action.type === "platform" ? "call" : "type"}`,
        message: "Channel callbacks cannot request, navigate or connect",
      };
    }
    for (const key of ["actions", "onSuccess", "onError"]) {
      const error = callbackError(action[key], `${at}.${key}`);
      if (error) {
        return error;
      }
    }
  }
  return undefined;
}

/** A channel selector is static; body remains an ordinary value binding. */
export function prototypeChannelCallError(
  action: Raw,
  path: string,
  spec: Raw,
): PrototypePlatformError | undefined {
  if (typeof action.call !== "string" || !action.call.startsWith("realtime.")) {
    return undefined;
  }
  const channel = selectedChannel(action, spec);
  if (!channel) {
    return { path: `${path}.args.channel`, message: "channel must name a declared channel" };
  }
  const bodyError = sendBodyError(action, path);
  if (bodyError) {
    return bodyError;
  }
  return action.call === "realtime.send" && channel.kind !== "websocket"
    ? { path: `${path}.call`, message: "realtime.send requires a websocket channel" }
    : undefined;
}

function channelError(channel: Raw, at: string, root: Raw): PrototypePlatformError | undefined {
  const url = prototypeChannelUrlError(channel);
  if (url) {
    return { path: `${at}.url`, message: url };
  }
  const headers = channelHeadersError(channel, at);
  if (headers) {
    return headers;
  }
  const protocols = channelProtocolsError(channel, at);
  if (protocols) {
    return protocols;
  }
  for (const name of ["onOpen", "onClose", "onError"]) {
    const error = callbackError(channel[name], `${at}.${name}`);
    if (error) {
      return error;
    }
  }
  const status = prototypeRequestStatusKeyError(
    { ...channel, type: "request" },
    at,
    record(root.state) ?? {},
  );
  if (status) {
    return status;
  }
  const reconnect = channelReconnectError(channel, at);
  if (reconnect) {
    return reconnect;
  }
  const routes = channelRoutesError(channel, at);
  if (routes) {
    return routes;
  }
  return undefined;
}

function channelHeadersError(channel: Raw, at: string): PrototypePlatformError | undefined {
  const headers = record(channel.headers) ?? {};
  for (const name of Object.keys(headers).sort()) {
    if (name.toLowerCase().startsWith("sec-websocket-") || name.toLowerCase() === "last-event-id") {
      return { path: atKey(`${at}.headers`, name), message: "Forbidden channel header" };
    }
  }
  return prototypeRequestEntryError(
    Object.fromEntries(
      Object.keys(headers)
        .sort()
        .map((key) => [key, headers[key]]),
    ),
    at,
    "headers",
  );
}

function channelProtocolsError(channel: Raw, at: string): PrototypePlatformError | undefined {
  if (channel.kind !== "websocket" && channel.protocols !== undefined) {
    return {
      path: `${at}.protocols`,
      message: "protocols are only available for websocket channels",
    };
  }
  const protocols = channel.protocols as string[] | undefined;
  if (
    protocols &&
    (new Set(protocols).size !== protocols.length ||
      protocols.some(
        (value) =>
          value.length < 1 || value.length > 64 || /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(value),
      ))
  ) {
    return {
      path: `${at}.protocols`,
      message: "protocols must be unique RFC 7230 tokens of 1 to 64 characters",
    };
  }
  return undefined;
}

function channelReconnectError(channel: Raw, at: string): PrototypePlatformError | undefined {
  const reconnect = record(channel.reconnect);
  if (reconnect && Number(reconnect.initialDelayMs) > Number(reconnect.maxDelayMs)) {
    return {
      path: `${at}.reconnect.initialDelayMs`,
      message: "initialDelayMs must not exceed maxDelayMs",
    };
  }
  return undefined;
}

function channelRoutesError(channel: Raw, at: string): PrototypePlatformError | undefined {
  for (const [index, route] of (Array.isArray(channel.routes) ? channel.routes : []).entries()) {
    if (channel.kind !== "sse" && record(record(route)?.when)?.event !== undefined) {
      return {
        path: `${at}.routes[${index}].when.event`,
        message: "Event name matchers are only available for sse channels",
      };
    }
    const error = routeActionsError(record(route)?.actions as Raw[], `${at}.routes[${index}]`);
    if (error) {
      return error;
    }
  }
  return undefined;
}

function routeActionsError(actions: Raw[], at: string): PrototypePlatformError | undefined {
  for (const [actionIndex, action] of actions.entries()) {
    if (
      ![
        "setState",
        "toggle",
        "increment",
        "decrement",
        "setData",
        "appendData",
        "prependData",
        "upsertData",
        "removeData",
      ].includes(String(action.type))
    ) {
      return {
        path: `${at}.actions[${actionIndex}].type`,
        message: "Channel routes only allow state and data actions",
      };
    }
  }
  return undefined;
}

function sendBodyError(action: Raw, path: string): PrototypePlatformError | undefined {
  const body = record(record(action.args)?.body);
  if (
    action.call === "realtime.send" &&
    body &&
    Object.hasOwn(body, "value") &&
    Buffer.byteLength(
      typeof body.value === "string" ? body.value : JSON.stringify(body.value),
      "utf8",
    ) > MAX_PROTOTYPE_CHANNEL_SEND_BYTES
  ) {
    return {
      path: `${path}.args.body.value`,
      message: "realtime.send body exceeds the byte limit",
    };
  }
  return undefined;
}

function selectedChannel(action: Raw, spec: Raw): Raw | undefined {
  const selector = record(action.args)?.channel;
  const id = typeof selector === "string" ? selector : record(selector)?.value;
  const channels = record(spec.channels) ?? {};
  return typeof id === "string" && Object.hasOwn(channels, id) ? record(channels[id]) : undefined;
}
