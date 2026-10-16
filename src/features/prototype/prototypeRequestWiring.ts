/**
 * Production wiring for host-proxied prototype requests (#12527), kept out of the large tool and
 * client files.
 */
import type { Timer } from "../../utils/SystemTimer";
import { FetchPrototypeHttpExecutor } from "./PrototypeHttpExecutor";
import { PrototypeRequestCoordinator } from "./PrototypeRequestCoordinator";
import { createPrototypeRequestHost, type PrototypeRequestHost } from "./prototypeRequestHandler";

export type { PrototypeRequestCoordinator };

/** The fetch-backed coordinator the daemon prototype host owns. */
export function createPrototypeRequestCoordinator(
  timer: Pick<Timer, "setTimeout" | "clearTimeout" | "now">,
): PrototypeRequestCoordinator {
  return new PrototypeRequestCoordinator(new FetchPrototypeHttpExecutor({ timer }));
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
