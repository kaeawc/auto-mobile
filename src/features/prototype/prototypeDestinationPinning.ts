/**
 * Resolves a prototype destination once and validates every answer against the egress policy
 * (#12527, #14268). Shared by the HTTP request executor and the channel transports so a request,
 * a redirect hop and a WebSocket or SSE handshake are all held to the same pinned address.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import {
  checkUrl,
  destinationPort,
  type EgressPolicy,
  type HostResolver,
  type ResolvedHostAddress,
} from "./prototypeEgressPolicy";
import type { PrototypeRequestErrorCode } from "./prototypeRequestProtocol";

export interface PrototypeDestinationPinning {
  policy: EgressPolicy;
  resolver: HostResolver;
  timer: Pick<Timer, "setTimeout" | "clearTimeout">;
}

export type PrototypeDestinationRefusal = { code: PrototypeRequestErrorCode; message: string };

export const systemHostResolver: HostResolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/** Checks `url` and returns the one validated address the transport may connect to. */
export async function pinPrototypeDestination(
  url: URL,
  deps: PrototypeDestinationPinning,
  signal: AbortSignal,
): Promise<ResolvedHostAddress | PrototypeDestinationRefusal> {
  if (url.username || url.password) {
    return { code: "invalid_request", message: "URL credentials are not permitted." };
  }
  const blocked = checkUrl(url, deps.policy);
  if (blocked !== undefined) {
    return { code: "blocked_destination", message: blocked };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await raceWithDeadline(() => deps.resolver(hostname), {
        timer: deps.timer,
        signal,
        label: "Prototype destination resolution",
      });
  signal.throwIfAborted();
  if (addresses.length === 0) {
    return { code: "network", message: "The destination did not resolve to an address." };
  }
  if (
    addresses.some(
      ({ address, family }) =>
        !isIP(address) ||
        isIP(address) !== family ||
        !deps.policy.permitsAddress(address, destinationPort(url)),
    )
  ) {
    return { code: "blocked_destination", message: "The destination is not permitted." };
  }
  return addresses[0]!;
}
