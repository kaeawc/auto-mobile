import { ActionableError, toActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../models/describeUnknownError";
import type { Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import type {
  PreviewHttpBinder,
  PreviewHttpListener,
  PreviewHttpRequest,
  PreviewHttpResponse,
} from "./prototypePreviewHttp";
import {
  parsePrototypePreviewRoute,
  PROTOTYPE_PREVIEW_EVENT_HEADERS,
  prototypePreviewPath,
  prototypePreviewRefusal,
  prototypePreviewResponse,
  type PrototypePreviewRoute,
} from "./prototypePreviewRoutes";
import type { PrototypePreviewPageSource } from "./prototypePreviewSource";
import { DEFAULT_PROTOTYPE_PREVIEW_IDLE_TIMEOUT_MS } from "./prototypePreviewLimits";

/** An SSE comment this often keeps open pages' connections from idling out. */
export const PROTOTYPE_PREVIEW_KEEPALIVE_MS = 15_000;

const LOOPBACK_HOST = "127.0.0.1";
const ALL_INTERFACES = "0.0.0.0";

export interface PrototypePreviewServeOptions {
  /** 0 or absent: an OS-chosen free port. */
  readonly port?: number;
  /** Bind every interface instead of loopback only. */
  readonly remote?: boolean;
  readonly idleTimeoutMs?: number;
}

export type PrototypePreviewStopReason = "stop" | "idle" | "daemon";

export interface PrototypePreviewInfo {
  readonly running: boolean;
  /** The index page; on a remote server, other machines use this host's address instead. */
  readonly url?: string;
  readonly host?: string;
  readonly port?: number;
  readonly remote?: boolean;
  readonly idleTimeoutMs?: number;
  /** Why the last server stopped, while none is running. */
  readonly stoppedReason?: PrototypePreviewStopReason;
}

/** The narrow surface the tool and the daemon shutdown use. */
export interface PrototypePreviewControl {
  serve(options: PrototypePreviewServeOptions): Promise<PrototypePreviewInfo>;
  stop(reason?: PrototypePreviewStopReason): Promise<PrototypePreviewInfo>;
  /** Absent until the first serve in this process. */
  info(): PrototypePreviewInfo | undefined;
  /** The live page URL of a prototype id on the running server. */
  pageUrl(id: string): string | undefined;
}

export interface PrototypePreviewServerDependencies {
  readonly source: PrototypePreviewPageSource;
  readonly http: PreviewHttpBinder;
  readonly timer: Timer;
}

interface Running {
  readonly listener: PreviewHttpListener;
  readonly host: string;
  readonly remote: boolean;
  /** The port asked for (0 = any), to tell whether a later serve asks for another. */
  readonly requestedPort: number;
  idleTimeoutMs: number;
  readonly unsubscribe: () => void;
  readonly keepalive: NodeJS.Timeout;
}

interface EventStream {
  readonly id: string;
  readonly response: PreviewHttpResponse;
  /** The ids last found related, so a variant that left the group still reloads once. */
  watched: ReadonlySet<string>;
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE"
  );
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The live preview server for shown prototypes (#17975). One per daemon: `serve` binds it, `stop`,
 * the daemon's shutdown and the idle timeout close it. Operations are serialized, so concurrent
 * serve and stop calls from several MCP connections never leave two sockets bound.
 */
export class PrototypePreviewServer implements PrototypePreviewControl {
  private running: Running | undefined;
  private readonly streams = new Set<EventStream>();
  private idleHandle: NodeJS.Timeout | undefined;
  private generation = 0;
  private stoppedReason: PrototypePreviewStopReason | undefined;
  private served = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dependencies: PrototypePreviewServerDependencies) {}

  serve(options: PrototypePreviewServeOptions): Promise<PrototypePreviewInfo> {
    return this.serialized(() => this.serveNow(options));
  }

  stop(reason: PrototypePreviewStopReason = "stop"): Promise<PrototypePreviewInfo> {
    return this.serialized(async () => {
      await this.stopNow(reason);
      return this.info() ?? { running: false };
    });
  }

  info(): PrototypePreviewInfo | undefined {
    const running = this.running;
    if (running === undefined) {
      if (!this.served) {
        return undefined;
      }
      return {
        running: false,
        ...(this.stoppedReason ? { stoppedReason: this.stoppedReason } : {}),
      };
    }
    const port = running.listener.port;
    return {
      running: true,
      url: `http://${LOOPBACK_HOST}:${port}/`,
      host: running.host,
      port,
      remote: running.remote,
      idleTimeoutMs: running.idleTimeoutMs,
    };
  }

  pageUrl(id: string): string | undefined {
    const running = this.running;
    return running && `http://${LOOPBACK_HOST}:${running.listener.port}${prototypePreviewPath(id)}`;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch((error) => {
      // The caller receives this rejection; the queue only orders the next operation after it.
      logger.debug(`[prototype] preview server operation failed: ${errorMessage(error)}`);
    });
    return next;
  }

  private async serveNow(options: PrototypePreviewServeOptions): Promise<PrototypePreviewInfo> {
    const remote = options.remote === true;
    const requestedPort = options.port ?? 0;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_PROTOTYPE_PREVIEW_IDLE_TIMEOUT_MS;
    const running = this.running;
    const samePort =
      requestedPort === 0 ||
      requestedPort === running?.requestedPort ||
      requestedPort === running?.listener.port;
    if (running && running.remote === remote && samePort) {
      running.idleTimeoutMs = idleTimeoutMs;
      this.touch();
      return this.info()!;
    }
    await this.stopNow("stop");
    const host = remote ? ALL_INTERFACES : LOOPBACK_HOST;
    const listener = await this.bind(host, requestedPort);
    // Changes while stopped were not counted: a tab reconnecting to the new listener must see a
    // different generation in ready, so it reloads.
    this.generation += 1;
    this.served = true;
    this.stoppedReason = undefined;
    this.running = {
      listener,
      host,
      remote,
      requestedPort,
      idleTimeoutMs,
      unsubscribe: this.dependencies.source.onChange((id) => this.changed(id)),
      keepalive: this.dependencies.timer.setInterval(
        () => this.broadcastKeepalive(),
        PROTOTYPE_PREVIEW_KEEPALIVE_MS,
      ),
    };
    this.touch();
    return this.info()!;
  }

  private async bind(host: string, port: number): Promise<PreviewHttpListener> {
    try {
      return await this.dependencies.http.listen({ host, port }, (request, response) =>
        this.handle(request, response),
      );
    } catch (error) {
      if (isAddressInUse(error)) {
        throw new ActionableError(
          `Port ${port} is already in use on ${host}: pass another port, or omit port for a free one.`,
        );
      }
      throw toActionableError(error, "Failed to start the prototype preview server");
    }
  }

  private async stopNow(reason: PrototypePreviewStopReason): Promise<void> {
    const running = this.running;
    if (running === undefined) {
      return;
    }
    this.running = undefined;
    this.stoppedReason = reason;
    this.clearIdle();
    running.unsubscribe();
    this.dependencies.timer.clearInterval(running.keepalive);
    [...this.streams].forEach((stream) => stream.response.end());
    this.streams.clear();
    await running.listener.close();
    logger.info(`[prototype] preview server on port ${running.listener.port} stopped (${reason})`);
  }

  private clearIdle(): void {
    if (this.idleHandle !== undefined) {
      this.dependencies.timer.clearTimeout(this.idleHandle);
      this.idleHandle = undefined;
    }
  }

  /** Activity: restarts the idle countdown, which runs only while no page is open. */
  private touch(): void {
    this.clearIdle();
    const running = this.running;
    if (running === undefined || this.streams.size > 0) {
      return;
    }
    this.idleHandle = this.dependencies.timer.setTimeout(() => {
      this.idleHandle = undefined;
      this.stop("idle").catch((error) => {
        logger.warn(`[prototype] preview server idle stop failed: ${errorMessage(error)}`, error);
      });
    }, running.idleTimeoutMs);
  }

  private handle(request: PreviewHttpRequest, response: PreviewHttpResponse): void {
    const running = this.running;
    if (running === undefined) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("The preview server is stopping");
      return;
    }
    this.touch();
    const refusal = this.refusal(request, running);
    if (refusal) {
      response.writeHead(refusal.status, refusal.headers);
      response.end(refusal.body);
      return;
    }
    const route = parsePrototypePreviewRoute(request.url);
    if (route.kind === "events") {
      this.openStream(route.id, response);
      return;
    }
    void this.respond(route, response);
  }

  private refusal(request: PreviewHttpRequest, running: Running) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return prototypePreviewRefusal.method();
    }
    // A page on another site could rebind its own name to 127.0.0.1; loopback names only.
    const port = running.listener.port;
    const loopbackNames = [`${LOOPBACK_HOST}:${port}`, `localhost:${port}`, `[::1]:${port}`];
    const host = request.host?.toLowerCase();
    if (!running.remote && host !== undefined && !loopbackNames.includes(host)) {
      return prototypePreviewRefusal.host();
    }
    return undefined;
  }

  private async respond(
    route: Exclude<PrototypePreviewRoute, { kind: "events" }>,
    response: PreviewHttpResponse,
  ): Promise<void> {
    try {
      const answer = await prototypePreviewResponse(route, this.dependencies.source);
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body);
    } catch (error) {
      logger.warn(`[prototype] preview request failed: ${errorMessage(error)}`, error);
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("The preview request failed; see the daemon log.");
    }
  }

  private openStream(id: string, response: PreviewHttpResponse): void {
    const stream: EventStream = { id, response, watched: new Set(this.related(id)) };
    this.streams.add(stream);
    this.clearIdle();
    response.onClose(() => {
      if (this.streams.delete(stream)) {
        this.touch();
      }
    });
    response.writeHead(200, PROTOTYPE_PREVIEW_EVENT_HEADERS);
    response.write(`retry: 1000\n\n${sse("ready", { generation: this.generation })}`);
  }

  private related(id: string): readonly string[] {
    try {
      return this.dependencies.source.related(id);
    } catch (error) {
      // A group read can race an eviction; the page's own id is still the one to watch.
      logger.debug(`[prototype] preview related ids of ${id} unavailable: ${errorMessage(error)}`);
      return [id];
    }
  }

  private changed(id: string): void {
    this.generation += 1;
    this.touch();
    const event = sse("reload", { id, generation: this.generation });
    this.streams.forEach((stream) => {
      const related = this.related(stream.id);
      if (stream.id === id || stream.watched.has(id) || related.includes(id)) {
        stream.response.write(event);
      }
      stream.watched = new Set(related);
    });
  }

  private broadcastKeepalive(): void {
    this.streams.forEach((stream) => stream.response.write(": keepalive\n\n"));
  }
}
