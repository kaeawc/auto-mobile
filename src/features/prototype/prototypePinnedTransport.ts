import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { checkServerIdentity } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { PrototypeFetch } from "./PrototypeHttpExecutor";

export class PrototypeResponseTooLargeError extends Error {}

export interface PrototypeClientRequest {
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "upgrade",
    listener: (response: IncomingMessage, socket: { destroy(): unknown }) => void,
  ): unknown;
  end(body?: RequestInit["body"]): unknown;
  destroy(error?: Error): unknown;
}

/** Narrow request seam; tests never need a socket or DNS lookup. */
export type PrototypeRequestFactory = (
  options: RequestOptions,
  onResponse: (incoming: IncomingMessage) => void,
) => PrototypeClientRequest;

function decodedBody(incoming: IncomingMessage): Readable {
  const encoding = incoming.headers["content-encoding"]?.toLowerCase();
  const decoder =
    encoding === "gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : undefined;
  if (!decoder) {
    return incoming;
  }
  incoming.once("error", (error) => decoder.destroy(error));
  decoder.once("close", () => incoming.destroy());
  return incoming.pipe(decoder);
}

function responseOf(
  incoming: IncomingMessage,
  method: string | undefined,
  maxBytes: number,
): Response {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
  }
  const status = incoming.statusCode ?? 502;
  if (method === "HEAD" || [204, 205, 304].includes(status)) {
    incoming.destroy();
    return new Response(null, { status, headers });
  }
  const stream = decodedBody(incoming);
  if (stream !== incoming) {
    // Wire length and encoding describe compressed bytes, not the body exposed below.
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  const iterator = stream[Symbol.asyncIterator]();
  let total = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
      } else if (value instanceof Uint8Array) {
        total += value.byteLength;
        if (total > maxBytes) {
          // Stop the decoder and its input at the first chunk crossing the decoded-byte cap.
          stream.destroy();
          incoming.destroy();
          controller.error(new PrototypeResponseTooLargeError());
        } else {
          controller.enqueue(value);
        }
      } else {
        controller.error(new Error("Unexpected response chunk type."));
        stream.destroy();
        incoming.destroy();
      }
    },
    async cancel() {
      incoming.destroy();
      stream.destroy();
      await iterator.return?.();
    },
  });
  return new Response(body, { status, headers });
}

/** One connection, directly to the validated IP. No hostname lookup or redirect occurs here. */
export function createPinnedPrototypeFetch(
  send: PrototypeRequestFactory = (options, onResponse) =>
    (options.protocol === "https:" ? httpsRequest : httpRequest)(options, onResponse),
  environment: NodeJS.ProcessEnv = process.env,
  runtime: "bun" | "node" = process.versions.bun ? "bun" : "node",
): PrototypeFetch {
  return (raw, init, pinned, maxBytes) => {
    init.signal?.throwIfAborted();
    // Bun 1.3.14's node:http delegates to fetch and has no per-request environment-proxy
    // opt-out. Refuse before connecting when any proxy environment could reroute the pinned IP.
    // Do not temporarily mutate process.env: concurrent requests would observe that mutation.
    if (
      runtime === "bun" &&
      // Bun exposes standard proxy keys via getters but omits them from enumeration.
      (["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].some(
        (name) => Boolean(environment[name]),
      ) ||
        Object.entries(environment).some(
          ([name, value]) => /^(http|https|all)_proxy$/i.test(name) && Boolean(value),
        ))
    ) {
      return Promise.reject(new Error("Pinned transport requires a direct connection."));
    }
    const url = new URL(raw);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const headers = new Headers(init.headers);
    headers.set("Host", url.host);
    if (!headers.has("accept-encoding")) {
      headers.set("Accept-Encoding", "gzip, deflate, br");
    }
    return new Promise((resolve, reject) => {
      // A fresh plain agent bypasses global proxy agents; empty proxyEnv also disables
      // Node's environment-proxy support regardless of NODE_USE_ENV_PROXY or NO_PROXY.
      const agent =
        url.protocol === "https:"
          ? new HttpsAgent({ proxyEnv: {} })
          : new HttpAgent({ proxyEnv: {} });
      let response: IncomingMessage | undefined;
      const cleanup = () => {
        init.signal?.removeEventListener("abort", onAbort);
        agent.destroy();
      };
      const request = send(
        {
          protocol: url.protocol,
          host: pinned.address,
          family: pinned.family,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + url.search,
          method: init.method,
          headers: Object.fromEntries(headers),
          servername: isIP(hostname) ? undefined : hostname,
          checkServerIdentity: (_server, certificate) => checkServerIdentity(hostname, certificate),
          agent,
        },
        (incoming) => {
          response = incoming;
          incoming.once("close", cleanup);
          if (
            incoming.statusCode === undefined ||
            incoming.statusCode < 200 ||
            incoming.statusCode > 599
          ) {
            incoming.destroy();
            reject(new Error("Invalid HTTP response status."));
            return;
          }
          resolve(responseOf(incoming, init.method, maxBytes));
        },
      );
      // Explicit destruction keeps cancellation consistent across node:http implementations.
      const onAbort = () => {
        const error = new Error("Request cancelled.");
        cleanup();
        response?.destroy(error);
        request.destroy(error);
        reject(error);
      };
      init.signal?.addEventListener("abort", onAbort, { once: true });
      request.on("error", (error) => {
        cleanup();
        reject(error);
      });
      request.on("upgrade", (_response, socket) => {
        socket.destroy();
        cleanup();
        reject(new Error("Protocol upgrades are not supported."));
      });
      if (init.signal?.aborted) {
        onAbort();
      } else {
        request.end(init.body);
      }
    });
  };
}

export const pinnedPrototypeFetch = createPinnedPrototypeFetch();
