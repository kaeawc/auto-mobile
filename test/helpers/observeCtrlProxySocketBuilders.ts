import type WebSocket from "ws";

/**
 * Typed builders that hand a socket test double to production seams that are
 * declared against the global `WebSocket`.
 *
 * Production code only touches a few members of the socket (`readyState`,
 * `send`, and the EventEmitter-style listeners supplied by `FakeWebSocket`),
 * so tests supply a narrow double. The single assertion below is the one place
 * that bridges the narrow double to the full `WebSocket` interface; it is a plain
 * assertion to a real named type (the double's declared members must overlap
 * `WebSocket` or the compiler rejects it), not an `any` or double cast.
 */

/** The members the CtrlProxy clients exercise on an injected socket. */
export type SocketDouble = Pick<WebSocket, "readyState" | "send">;

/** View a socket double as the `WebSocket` the production seam expects. */
export function asWebSocket(socket: SocketDouble): WebSocket {
  return socket as WebSocket;
}
