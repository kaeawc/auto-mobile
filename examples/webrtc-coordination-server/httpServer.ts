import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CoordinationServer, type CoordinationServerOptions } from "./coordinationServer";

export interface HttpCoordinationServerOptions extends CoordinationServerOptions {
  /** Optional bearer token required on WHIP ingest (Authorization: Bearer ...). */
  ingestToken?: string;
}

const VIEWER_HTML_PATH = join(import.meta.dir ?? __dirname, "viewer.html");

/**
 * HTTP/WHIP/WHEP front end for {@link CoordinationServer}.
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
        // Log the detail server-side; never expose error/stack text to the client.
        console.error("[coordination-server] request error:", error);
        this.sendJson(res, 500, { error: "internal server error" });
      });
    });
  }

  listen(port: number, host = "0.0.0.0"): Promise<number> {
    return new Promise(resolve => {
      this.server.listen(port, host, () => {
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
      const offer = await readBody(req);
      const { streamId, answerSdp } = await this.coordinator.ingest(
        offer,
        url.searchParams.get("streamId") ?? undefined
      );
      res.writeHead(201, {
        "Content-Type": "application/sdp",
        "Location": `/whip/${encodeURIComponent(streamId)}`,
      });
      res.end(answerSdp);
      return;
    }
    // WHIP trickle ICE: incremental candidates from the publisher --------------
    const whipPatchMatch = /^\/whip\/([^/]+)$/.exec(path);
    if (method === "PATCH" && whipPatchMatch) {
      if (!this.authorizeIngest(req)) {
        res.writeHead(401).end("Unauthorized");
        return;
      }
      const fragment = await readBody(req);
      const applied = await this.coordinator.addIngestCandidates(
        decodeURIComponent(whipPatchMatch[1]),
        fragment
      );
      // 204 on success; 404 if the stream id is unknown (stale resource).
      res.writeHead(applied ? 204 : 404).end();
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
