import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CoordinationServer, type CoordinationServerOptions } from "./coordinationServer";

export interface HttpCoordinationServerOptions extends CoordinationServerOptions {
  /** Optional bearer token required on WHIP ingest (Authorization: Bearer ...). */
  ingestToken?: string;
}

const VIEWER_HTML_PATH = join(import.meta.dir ?? __dirname, "viewer.html");
const MAX_SDP_BODY_BYTES = 1_000_000;

class RequestBodyTooLargeError extends Error {}
class InvalidSdpError extends Error {}

/**
 * HTTP/WHIP/WHEP front end for {@link CoordinationServer}.
 *
 * WHIP setup, resource `Location`, DELETE, trickle PATCH, and bearer auth are
 * implemented from RFC 9725: https://www.rfc-editor.org/rfc/rfc9725.html.
 * WHEP remains an Internet-Draft:
 * https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep
 *
 * Routes:
 *   POST   /whip[?streamId=]         WHIP ingest (from AutoMobile)   -> 201 + Location
 *   DELETE /whip/:streamId           terminate ingest
 *   POST   /whep/:streamId           WHEP subscribe (from browser)   -> 201 + Location
 *   DELETE /whep/:streamId/:subId    terminate subscriber
 *   GET    /api/streams              reconnect API: list streams
 *   GET    /api/streams/:streamId    reconnect API: one stream
 *   GET    /  or  /viewer            browser viewer page
 */
export class HttpCoordinationServer {
  readonly coordinator: CoordinationServer;
  private readonly ingestToken?: string;
  private readonly server: Server;

  constructor(options: HttpCoordinationServerOptions = {}) {
    this.coordinator = new CoordinationServer(options);
    this.ingestToken = options.ingestToken;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(error => {
        if (error instanceof RequestBodyTooLargeError) {
          res.writeHead(413).end("request body too large");
          return;
        }
        if (error instanceof InvalidSdpError) {
          res.writeHead(400).end("invalid SDP");
          return;
        }
        // Log the detail server-side; never expose error/stack text to the client.
        console.error("[coordination-server] request error:", error);
        this.sendJson(res, 500, { error: "internal server error" });
      });
    });
  }

  listen(port: number, host = "0.0.0.0"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        const address = this.server.address();
        const boundPort = typeof address === "object" && address ? address.port : port;
        resolve(boundPort);
      });
    });
  }

  async close(): Promise<void> {
    await this.coordinator.close();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname;
    this.applyCors(res);

    if (method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (method === "GET" && (path === "/whip" || path === "/whep" || /^\/(whip|whep)\/[^/]+$/.test(path) || /^\/whep\/[^/]+\/[^/]+$/.test(path))) {
      res.writeHead(204).end();
      return;
    }
    if (method === "HEAD" && /^\/whep\/[^/]+$/.test(path)) {
      res.writeHead(200, { "Content-Type": "application/sdp" }).end();
      return;
    }

    // Reconnect API ---------------------------------------------------------
    if (method === "GET" && path === "/api/streams") {
      this.sendJson(res, 200, { streams: this.coordinator.listStreams() });
      return;
    }
    const streamApiMatch = /^\/api\/streams\/([^/]+)$/.exec(path);
    if (method === "GET" && streamApiMatch) {
      const descriptor = this.coordinator.getStream(decodeURIComponent(streamApiMatch[1]));
      if (!descriptor) {
        this.sendJson(res, 404, { error: "stream not found" });
        return;
      }
      this.sendJson(res, 200, descriptor);
      return;
    }

    // WHIP ingest -----------------------------------------------------------
    if (method === "POST" && path === "/whip") {
      if (!this.authorizeIngest(req)) {
        res.writeHead(401).end("Unauthorized");
        return;
      }
      assertContentType(req, "application/sdp");
      const offer = await readBody(req);
      let ingest: { streamId: string; answerSdp: string; etag: string };
      try {
        ingest = await this.coordinator.ingest(offer, url.searchParams.get("streamId") ?? undefined);
      } catch {
        throw new InvalidSdpError();
      }
      res.writeHead(201, {
        "Content-Type": "application/sdp",
        "Location": `/whip/${encodeURIComponent(ingest.streamId)}`,
        "ETag": `\"${ingest.etag}\"`,
      });
      res.end(ingest.answerSdp);
      return;
    }
    // WHIP trickle ICE: incremental candidates from the publisher --------------
    const whipPatchMatch = /^\/whip\/([^/]+)$/.exec(path);
    if (method === "PATCH" && whipPatchMatch) {
      if (!this.authorizeIngest(req)) {
        res.writeHead(401).end("Unauthorized");
        return;
      }
      assertContentType(req, "application/trickle-ice-sdpfrag");
      const ifMatch = req.headers["if-match"];
      if (typeof ifMatch !== "string") { res.writeHead(428).end(); return; }
      const streamId = decodeURIComponent(whipPatchMatch[1]);
      const etag = this.coordinator.getIceEtag(streamId);
      if (!etag) { res.writeHead(404).end(); return; }
      if (ifMatch !== `\"${etag}\"`) { res.writeHead(412).end(); return; }
      const fragment = await readBody(req);
      const applied = await this.coordinator.addIngestCandidates(
        streamId,
        fragment
      );
      res.writeHead(applied === "applied" ? 204 : applied === "restart" ? 422 : applied === "invalid" ? 400 : 404).end();
      return;
    }
    const whipDeleteMatch = /^\/whip\/([^/]+)$/.exec(path);
    if (method === "DELETE" && whipDeleteMatch) {
      // Terminating an ingest is as privileged as creating one — gate on the
      // same token so a guessed stream id can't kill a live stream.
      if (!this.authorizeIngest(req)) {
        res.writeHead(401).end("Unauthorized");
        return;
      }
      await this.coordinator.stopIngest(decodeURIComponent(whipDeleteMatch[1]));
      res.writeHead(200).end();
      return;
    }

    // WHEP subscribe --------------------------------------------------------
    const whepMatch = /^\/whep\/([^/]+)$/.exec(path);
    if (method === "POST" && whepMatch) {
      const streamId = decodeURIComponent(whepMatch[1]);
      if (!hasContentType(req, "application/sdp")) {
        res.writeHead(415).end("unsupported SDP media type");
        return;
      }
      const offer = await readBody(req);
      try {
        const { subscriberId, answerSdp } = await this.coordinator.subscribe(streamId, offer);
        res.writeHead(201, {
          "Content-Type": "application/sdp",
          "Location": `/whep/${encodeURIComponent(streamId)}/${encodeURIComponent(subscriberId)}`,
        });
        res.end(answerSdp);
      } catch (error) {
        // Log the detail server-side; return a fixed message so no error/stack
        // text (which may derive from a stack trace) reaches the client.
        console.error(`[coordination-server] WHEP subscribe failed for ${streamId}:`, error);
        this.sendJson(res, 404, { error: "stream not found or invalid offer" });
      }
      return;
    }
    const whepDeleteMatch = /^\/whep\/([^/]+)\/([^/]+)$/.exec(path);
    if (method === "DELETE" && whepDeleteMatch) {
      await this.coordinator.stopSubscriber(
        decodeURIComponent(whepDeleteMatch[1]),
        decodeURIComponent(whepDeleteMatch[2])
      );
      res.writeHead(200).end();
      return;
    }

    // Viewer ----------------------------------------------------------------
    if (method === "GET" && (path === "/" || path === "/viewer" || path === "/index.html")) {
      this.serveViewer(res);
      return;
    }

    res.writeHead(404).end("Not found");
  }

  private authorizeIngest(req: IncomingMessage): boolean {
    if (!this.ingestToken) {
      return true;
    }
    const auth = req.headers["authorization"];
    return auth === `Bearer ${this.ingestToken}`;
  }

  private serveViewer(res: ServerResponse): void {
    try {
      const html = readFileSync(VIEWER_HTML_PATH, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(500).end("viewer.html not found");
    }
  }

  private applyCors(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
}

function assertContentType(req: IncomingMessage, expected: string): void {
  if (!hasContentType(req, expected)) {
    throw new InvalidSdpError();
  }
}

function hasContentType(req: IncomingMessage, expected: string): boolean {
  return req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_SDP_BODY_BYTES) {
        reject(new RequestBodyTooLargeError());
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
