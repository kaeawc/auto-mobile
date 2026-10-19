import type { ForwardClientConnectionProbe } from "./CtrlProxyForwardClientProbe";

/**
 * Reports no client connections. The default for `createForTesting` clients
 * only, so unit tests never read the real host's TCP table.
 */
export class NoForwardClientConnectionProbe implements ForwardClientConnectionProbe {
  public async findClientPids(): Promise<number[]> {
    return [];
  }
}
