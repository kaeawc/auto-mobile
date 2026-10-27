import { record } from "./prototypeTemplate";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
const atKey = (path: string, key: string): string =>
  prototypeContractPatterns.pathKey.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
/** Each channel action list is an event handler; route matchers themselves are not event reads. */
export function prototypeChannelHandlers(spec: unknown): { value: unknown; path: string }[] {
  const channels = record(record(spec)?.channels) ?? {};
  return Object.keys(channels)
    .sort()
    .flatMap((id) => {
      const channel = record(channels[id]) ?? {};
      const at = atKey("channels", id);
      const handlers = ["onOpen", "onClose", "onError"]
        .filter((key) => channel[key] !== undefined)
        .map((key) => ({ value: channel[key], path: `${at}.${key}` }));
      const routes = Array.isArray(channel.routes) ? channel.routes : [];
      return [
        ...handlers,
        ...routes.map((route, index) => ({
          value: record(route)?.actions,
          path: `${at}.routes[${index}].actions`,
        })),
      ];
    });
}
