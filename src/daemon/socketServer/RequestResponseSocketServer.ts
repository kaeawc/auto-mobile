import { streamAuthRefusalFields } from "../streamSocketAuth";
import { errorMessage } from "../../utils/describeUnknownError";
import { Socket } from "node:net";
import { logger } from "../../utils/logger";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { BaseSocketServer } from "./BaseSocketServer";
import { SocketRequest, SocketResponse } from "./SocketServerTypes";

/** Per-request context an auxiliary server hands its handler. */
export interface RequestResponseContext {
  /** Aborts when the requesting client's socket closes before the reply is sent. */
  signal: AbortSignal;
}

interface ClientGoneState {
  /** Controllers of the requests currently in flight on the socket. */
  controllers: Set<AbortController>;
}

const FRAME_TOO_LARGE_ERROR = "Invalid request: frame too large";

/**
 * Abstract base class for request-response socket servers.
 * Handles sequential request processing with JSON-over-newline protocol, with
 * an opt-in bypass for requests safe to dispatch out of order.
 *
 * Subclasses implement:
 * - handleRequest(): Process a request and return a response
 * - createErrorResponse(): Create an error response for failed requests
 */
export abstract class RequestResponseSocketServer<
  TRequest extends SocketRequest,
  TResponse extends SocketResponse,
> extends BaseSocketServer {
  /** Map of socket to pending promise chain for sequential processing */
  protected pendingBySocket: WeakMap<Socket, Promise<void>> = new WeakMap();
  private pendingClientGoneBySocket: WeakMap<Socket, ClientGoneState> = new WeakMap();

  constructor(
    socketPath: string,
    timer: Timer = defaultTimer,
    serverName: string = "RequestResponse",
  ) {
    super(socketPath, timer, serverName);
  }

  /**
   * Process a single line of input. Queues requests for sequential processing
   * unless the subclass opts the parsed request out of the chain.
   */
  protected async processLine(socket: Socket, line: string): Promise<void> {
    const request = this.bypassesRequestChain ? this.parseJson<TRequest>(line) : undefined;
    if (request && this.bypassesRequestChain?.(request)) {
      return this.handleLine(socket, line, request).catch((error) => {
        logger.error(`[${this.serverName}] Request processing error: ${error}`);
      });
    }

    // Get or create the pending promise chain for this socket
    const pending = this.pendingBySocket.get(socket) ?? Promise.resolve();

    // Chain this request to run after any pending requests
    const newPending = pending
      .then(() => this.handleLine(socket, line, request))
      .catch((error) => {
        logger.error(`[${this.serverName}] Request processing error: ${error}`);
      });

    this.pendingBySocket.set(socket, newPending);
  }

  /**
   * Answer an oversized frame with a structured error, then drop the connection
   * once the reply is flushed. The request id is unknowable: the frame was never
   * completed or parsed, and scanning its prefix for an id would be a heuristic.
   */
  protected onFrameOverflow(socket: Socket): void {
    if (socket.destroyed) {
      return;
    }
    const errorResponse = this.createErrorResponse(undefined, FRAME_TOO_LARGE_ERROR);
    socket.write(JSON.stringify(errorResponse) + "\n", () => socket.destroy());
  }

  /**
   * Dispatch a parsed request or answer invalid JSON.
   */
  private async handleLine(
    socket: Socket,
    line: string,
    parsedRequest?: TRequest | null,
  ): Promise<void> {
    const request = parsedRequest === undefined ? this.parseJson<TRequest>(line) : parsedRequest;
    if (!request) {
      const errorResponse = this.createErrorResponse(undefined, "Invalid JSON");
      this.sendJson(socket, errorResponse);
      return;
    }

    // Aborts when the client goes away before the reply, so a handler that honours the signal can
    // stop work nobody will read (#11817).
    const clientGone = this.trackClientGone(socket);
    try {
      const response = await this.handleRequest(request, { signal: clientGone.signal });
      this.sendJson(socket, response);
    } catch (error) {
      logger.error(`[${this.serverName}] Request handler error: ${error}`);
      const errorResponse = {
        ...this.createErrorResponse(request.id, errorMessage(error)),
        ...streamAuthRefusalFields(error),
      };
      this.sendJson(socket, errorResponse);
    } finally {
      this.pendingClientGoneBySocket.get(socket)?.controllers.delete(clientGone);
    }
  }

  /**
   * One `close` listener per socket aborts every in-flight request's controller, so pipelined
   * requests do not each add a listener. A request that starts after the socket already closed
   * (queued behind another) gets an already-aborted signal, since `close` will not fire again.
   */
  private trackClientGone(socket: Socket): AbortController {
    const controller = new AbortController();
    let state = this.pendingClientGoneBySocket.get(socket);
    if (!state) {
      const created: ClientGoneState = { controllers: new Set() };
      state = created;
      this.pendingClientGoneBySocket.set(socket, created);
      socket.once("close", () => {
        for (const pending of created.controllers) {
          pending.abort(new Error("Client socket closed"));
        }
        created.controllers.clear();
      });
    }
    if (socket.destroyed) {
      controller.abort(new Error("Client socket closed"));
    } else {
      state.controllers.add(controller);
    }
    return controller;
  }

  /** Implement only for requests that may safely run outside per-socket ordering. */
  protected bypassesRequestChain?(request: TRequest): boolean;

  /**
   * Handle a request and return a response.
   * Subclasses must implement this.
   */
  protected abstract handleRequest(
    request: TRequest,
    context?: RequestResponseContext,
  ): Promise<TResponse>;

  /**
   * Create an error response for a failed request.
   * Subclasses must implement this.
   */
  protected abstract createErrorResponse(id: string | undefined, error: string): TResponse;
}
