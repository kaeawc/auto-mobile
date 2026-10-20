import { logger } from "../../../utils/logger";
import { CtrlProxyServicePortChangedError } from "./CtrlProxyServicePortChangedError";
interface IosServiceEndpointChange {
  invalidateGeneration(): void;
  abortPendingConnect(): void;
  resetConnectionBudget(): void;
  hasLiveSocket(): boolean;
  retireLiveSocket(error: Error): void;
}
export function retireIosServiceEndpoint(context: IosServiceEndpointChange): void {
  // Invalidate any in-flight connect the same way close() does: a connect
  // that is mid-handshake snapshotted the old generation and is dialing the
  // now-stale old port (this.ws is still null, isConnecting is true), so its
  // `open` must be discarded rather than installed. Bumping the generation
  // makes the base connectWebSocket() open-guard drop that socket and clear
  // isConnecting, leaving a fresh connect free to dial the new port.
  context.invalidateGeneration();
  // Eagerly abort a handshake still stuck in CONNECTING (this.ws null,
  // isConnecting true, dialing the now-stale old port): the generation bump
  // above is only observed inside the socket's open/error handlers, so a
  // socket emitting neither would keep isConnecting true until
  // connectionTimeoutMs, stalling the new-port connect by up to ~5s. (#5656)
  context.abortPendingConnect();
  // The connection-attempt budget is per-endpoint: failures against the old
  // port must not cool down the new one. Without this reset, a port change on
  // the max-th in-flight attempt leaves connectionAttempts at the ceiling, so
  // connectWebSocket()'s cooldown check refuses to dial the new port for the
  // reset interval — the wedged state AC2 forbids.
  context.resetConnectionBudget();
  if (context.hasLiveSocket()) {
    logger.info("[IOSCtrlProxyClient] Closing stale WebSocket after CtrlProxy service port change");
    // Same teardown a lost connection gets (pending requests rejected,
    // per-connection caches/polling reset via onConnectionClosed, an error
    // listener kept on the closing socket), minus auto-reconnect.
    context.retireLiveSocket(new CtrlProxyServicePortChangedError());
  }
}
