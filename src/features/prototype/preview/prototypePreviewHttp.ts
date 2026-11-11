import { createServer, type Server, type ServerResponse } from "node:http";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../models/describeUnknownError";

/** One request, reduced to what the preview routes read. */
export interface PreviewHttpRequest {
  readonly method: string;
  readonly url: string;
  /** The Host header, checked against the bound address to refuse DNS rebinding. */
  readonly host?: string;
}

/** One response; `write` streams server-sent events. */
export interface PreviewHttpResponse {
  writeHead(status: number, headers: Readonly<Record<string, string>>): void;
  write(chunk: string): void;
  end(body?: string): void;
  /** Called once when the client goes away or the response ends. */
  onClose(listener: () => void): void;
}

export interface PreviewHttpListener {
  /** The bound port; the OS-chosen one when port 0 was asked for. */
  readonly port: number;
  /** Stops listening and drops every open connection, including event streams. */
  close(): Promise<void>;
}

export type PreviewHttpHandler = (
  request: PreviewHttpRequest,
  response: PreviewHttpResponse,
) => void;

/** Binds the preview server's socket; tests inject a fake that calls the handler directly. */
export interface PreviewHttpBinder {
  listen(
    address: { readonly host: string; readonly port: number },
    handler: PreviewHttpHandler,
  ): Promise<PreviewHttpListener>;
}

function wrapResponse(response: ServerResponse): PreviewHttpResponse {
  return {
    writeHead: (status, headers) => {
      response.writeHead(status, headers);
      // Event streams must reach the browser at once, not when a buffer fills.
      response.flushHeaders();
    },
    write: (chunk) => {
      response.write(chunk);
    },
    end: (body) => {
      response.end(body);
    },
    onClose: (listener) => {
      response.once("close", listener);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Open event streams never end on their own: drop them so close() settles.
    server.closeAllConnections();
  });
}

/** The node:http binder (Bun implements node:http; no dependency). */
export const nodePreviewHttpBinder: PreviewHttpBinder = {
  listen: (address, handler) =>
    new Promise((resolve, reject) => {
      const server = createServer((request, response) =>
        handler(
          { method: request.method ?? "GET", url: request.url ?? "/", host: request.headers.host },
          wrapResponse(response),
        ),
      );
      server.once("error", reject);
      server.listen(address.port, address.host, () => {
        server.off("error", reject);
        server.on("error", (error) => {
          logger.warn(`[prototype] preview server socket error: ${errorMessage(error)}`, error);
        });
        const bound = server.address();
        resolve({
          port: typeof bound === "object" && bound !== null ? bound.port : address.port,
          close: () => closeServer(server),
        });
      });
    }),
};
