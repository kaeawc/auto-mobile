import type { Socket } from "node:net";

/**
 * The single narrowing point for socket test doubles. Daemon code takes a concrete
 * `net.Socket`; a hand-written fake (an `EventEmitter` with the few members the
 * code touches) cannot satisfy that class structurally. An `object` -> class
 * assertion is legal, so no double cast through `unknown` is needed at call sites.
 */
export function asSocket(fake: object): Socket {
  return fake as Socket;
}
