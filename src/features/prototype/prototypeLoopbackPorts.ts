import { logger } from "../../utils/logger";
import { expandPrototypeComponents } from "./prototypeComponents";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { mapBindableFields, record } from "./prototypeTemplate";

/**
 * Finds the loopback ports a prototype's `via: "device"` requests need `adb reverse` for (#12530).
 * On an Android device `localhost` is the device itself, so such a request only reaches the host's
 * server through a reverse. The walk visits only real action slots (node, part and span action
 * lists, `scroll.refresh`, and nested request `onSuccess`/`onError`) through the shared bindable-field
 * walker, so opaque values (`data`, request bodies, emit context, component props) are never scanned.
 */

export interface UnreversibleLoopbackUrl {
  url: string;
  reason: string;
}

export interface DeviceLoopbackPorts {
  /** Distinct ports, ascending. */
  ports: number[];
  /** Device-side URLs that cannot be reversed automatically; the guide says to use via "host". */
  unreversible: UnreversibleLoopbackUrl[];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Port used when the URL omits one. Port 80 (http/ws) is reversed like any other: a request to
 * `http://localhost/` then reaches the host's port 80, matching via "host".
 */
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  "http:": 80,
  "https:": 443,
  "ws:": 80,
  "wss:": 443,
};

type Classified = { port: number } | { reason: string } | undefined;

function classifyUrl(url: string): Classified {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    // Expected for a templated URL: it is reported as unreversible, never reversed.
    logger.debug(`[prototype] loopback scan could not parse ${url}: ${error}`);
    return {
      reason: url.includes("{")
        ? "the host or port is a binding, so the port is unknown before the request runs"
        : "the URL cannot be parsed",
    };
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return undefined;
  }
  const port = parsed.port === "" ? DEFAULT_PORTS[parsed.protocol] : Number(parsed.port);
  return port === undefined ? { reason: `no port for the ${parsed.protocol} scheme` } : { port };
}

function collect(
  action: Record<string, unknown>,
  out: { ports: Set<number>; unreversible: Map<string, string> },
): void {
  if (typeof action.url !== "string") {
    return;
  }
  const classified = classifyUrl(action.url);
  if (classified && "port" in classified) {
    out.ports.add(classified.port);
  } else if (classified) {
    out.unreversible.set(action.url, classified.reason);
  }
}

export function extractDeviceLoopbackPorts(spec: unknown): DeviceLoopbackPorts {
  const found = { ports: new Set<number>(), unreversible: new Map<string, string>() };
  const expansion = expandPrototypeComponents(spec);
  if (expansion.success) {
    // Only the executable action slots are visited, so request-shaped JSON in `data`, a request
    // `body`, emit context or component props is never mistaken for an action.
    walkPrototypeNodes(expansion.spec, (node, path) => {
      mapBindableFields(node, path, (value, _at, kind) => {
        const action = record(value);
        if (kind === "deviceRequest" && action) {
          collect(action, found);
        }
        return value;
      });
    });
  }
  return {
    ports: [...found.ports].sort((a, b) => a - b),
    unreversible: [...found.unreversible].map(([url, reason]) => ({ url, reason })),
  };
}
