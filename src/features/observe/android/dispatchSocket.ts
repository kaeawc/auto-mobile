import WebSocket from "ws";
import type { SocketLike } from "../shared/types";

/**
 * True when a hierarchy request may still wait on the socket it was dispatched
 * over: no dispatch socket was pinned, or it is still open and still the client's
 * current socket (it must not have closed or been replaced during ADB fallback).
 */
export function isDispatchSocketValid(
  dispatchSocket: SocketLike | null | undefined,
  currentSocket: () => SocketLike | null,
): boolean {
  return (
    dispatchSocket === undefined ||
    (!!dispatchSocket &&
      dispatchSocket.readyState === WebSocket.OPEN &&
      currentSocket() === dispatchSocket)
  );
}
