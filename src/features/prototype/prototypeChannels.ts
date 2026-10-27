import { prototypeSpecNodeRoots } from "./prototypeNodeChildren";
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
  if (channel.kind === "websocket" && !/^wss?:/i.test(raw))
    return "A websocket channel url must use ws or wss";
  return prototypeRequestUrlError(url);
}

export function prototypeChannelsError(spec: unknown): PrototypePlatformError | undefined {
  const root = record(spec) ?? {};
  const channels = record(root.channels);
  if (!channels) return undefined;
  const requires = record(root.requires);
  if (!Array.isArray(requires?.platform) || !requires.platform.includes("realtime"))
    return { path: "channels", message: "Channels require realtime in requires.platform" };
  for (const id of Object.keys(channels).sort()) {
    const channel = record(channels[id])!;
    const at = atKey("channels", id);
    const url = prototypeChannelUrlError(channel);
    if (url) return { path: `${at}.url`, message: url };
    const headers = record(channel.headers) ?? {};
    for (const name of Object.keys(headers).sort()) {
      if (name.toLowerCase().startsWith("sec-websocket-") || name.toLowerCase() === "last-event-id")
        return { path: atKey(`${at}.headers`, name), message: "Forbidden channel header" };
    }
    const headerError = prototypeRequestEntryError(
      Object.fromEntries(
        Object.keys(headers)
          .sort()
          .map((key) => [key, headers[key]]),
      ),
      at,
      "headers",
    );
    if (headerError) return headerError;
    if (channel.kind !== "websocket" && channel.protocols !== undefined)
      return {
        path: `${at}.protocols`,
        message: "protocols are only available for websocket channels",
      };
    const status = prototypeRequestStatusKeyError(
      { ...channel, type: "request" },
      at,
      record(root.state) ?? {},
    );
    if (status) return status;
    const reconnect = record(channel.reconnect);
    if (reconnect && Number(reconnect.initialDelayMs) > Number(reconnect.maxDelayMs))
      return {
        path: `${at}.reconnect.initialDelayMs`,
        message: "initialDelayMs must not exceed maxDelayMs",
      };
    for (const [index, route] of (Array.isArray(channel.routes) ? channel.routes : []).entries()) {
      const actions = record(route)?.actions as Raw[];
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
        )
          return {
            path: `${at}.routes[${index}].actions[${actionIndex}].type`,
            message: "Channel routes only allow state and data actions",
          };
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
  if (typeof action.call !== "string" || !action.call.startsWith("realtime.")) return undefined;
  const selector = record(action.args)?.channel;
  const id = typeof selector === "string" ? selector : record(selector)?.value;
  const channels = record(spec.channels) ?? {};
  const channel =
    typeof id === "string" && Object.hasOwn(channels, id) ? record(channels[id]) : undefined;
  if (!channel)
    return { path: `${path}.args.channel`, message: "channel must name a declared channel" };
  return action.call === "realtime.send" && channel.kind !== "websocket"
    ? { path: `${path}.call`, message: "realtime.send requires a websocket channel" }
    : undefined;
}

/** Authored gates include components, styleWhen, handlers and nested action lists; literal JSON is opaque. */
export function prototypeRealtimeFields(spec: unknown, device = false): string[] {
  const root = record(spec) ?? {};
  const paths: string[] = [];
  const channels = record(root.channels);
  if (channels) {
    if (!device) paths.push("channels");
    else
      for (const id of Object.keys(channels).sort())
        if (record(channels[id])?.via === "device") paths.push(`${atKey("channels", id)}.via`);
  }
  if (device) return paths;
  function scan(value: unknown, path: string) {
    if (Array.isArray(value)) {
      value.forEach((child, index) => scan(child, `${path}[${index}]`));
      return;
    }
    const obj = record(value);
    if (!obj || (Object.keys(obj).length === 1 && Object.hasOwn(obj, "value"))) return;
    if (obj.type === "upsertData" || (obj.type === "appendData" && obj.maxItems !== undefined))
      paths.push(path);
    for (const key of Object.keys(obj).sort())
      if (!["data", "state", "payload", "repeat", "value"].includes(key)) {
        if (key === "screens" && record(obj[key])) {
          for (const [screen, child] of Object.entries(record(obj[key])!))
            scan(child, `${path}.screens[${JSON.stringify(screen)}]`);
        } else scan(obj[key], atKey(path, key));
      }
  }
  for (const { node, path } of prototypeSpecNodeRoots(root)) scan(node, path);
  for (const key of ["platform", "channels"]) scan(root[key], key);
  return paths;
}
