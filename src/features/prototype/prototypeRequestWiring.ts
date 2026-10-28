/**
 * Production wiring for host-proxied prototype requests (#12527), kept out of the large tool and
 * client files.
 */
import type { Timer } from "../../utils/SystemTimer";
import { FetchPrototypeHttpExecutor } from "./PrototypeHttpExecutor";
import type { PrototypeMockBackendRegistry } from "./PrototypeMockBackendRegistry";
import { MockRoutingPrototypeHttpExecutor } from "./PrototypeMockHttpExecutor";
import { PrototypeRequestCoordinator } from "./PrototypeRequestCoordinator";
import { createPrototypeRequestHost, type PrototypeRequestHost } from "./prototypeRequestHandler";

export type { PrototypeRequestCoordinator };

/**
 * The fetch-backed coordinator the daemon prototype host owns. Requests to the reserved mock origin
 * (#14271) are answered by `mocks` before the egress policy or any socket is involved.
 */
export function createPrototypeRequestCoordinator(
  timer: Pick<Timer, "setTimeout" | "clearTimeout" | "now">,
  mocks: PrototypeMockBackendRegistry,
): PrototypeRequestCoordinator {
  return new PrototypeRequestCoordinator(
    new MockRoutingPrototypeHttpExecutor(new FetchPrototypeHttpExecutor({ timer }), mocks, timer),
  );
}

/** Routes an iOS prototype agent's `prototype_request` frames and disconnects to the coordinator. */
export function attachIosPrototypeRequests(
  agent: { attachRequestHost?(host: PrototypeRequestHost | undefined): void },
  deviceId: string,
  requests: PrototypeRequestCoordinator | undefined,
): void {
  if (requests !== undefined) {
    agent.attachRequestHost?.(createPrototypeRequestHost(deviceId, requests));
  }
}

/** Routes an Android client's `prototype_request` frames and disconnects to the coordinator. */
export function attachAndroidPrototypeRequests(
  client: { attachPrototypeRequestHost?(host: PrototypeRequestHost | undefined): void },
  deviceId: string,
  requests: PrototypeRequestCoordinator | undefined,
): void {
  if (requests !== undefined) {
    client.attachPrototypeRequestHost?.(createPrototypeRequestHost(deviceId, requests));
  }
}
