/**
 * The mock backend engine (#14271): answers an HTTP request from a declarative definition with no
 * network. Canned routes win over collections, faults are decided before either, and latency and
 * `rate` faults draw from the injected seeded `Random` and wait on the injected `Timer`, so a run
 * replays identically.
 */
import type { IdGenerator } from "../../utils/IdGenerator";
import type { Random } from "../../utils/Random";
import type { Timer } from "../../utils/SystemTimer";
import { answerCollection, type MockResponse } from "./prototypeMockCollections";
import { bindMockValue, decodeURIComponentSafe, matchMockPath } from "./prototypeMockBinding";
import {
  MAX_MOCK_BACKEND_BYTES,
  type MockBackendDefinition,
  type MockFault,
  type MockItem,
  type MockRoute,
} from "./prototypeMockSchema";
import type { PrototypeRequestJson } from "./prototypeRequestProtocol";

export type { MockResponse };

export interface MockRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: PrototypeRequestJson | undefined;
}

export interface MockLogEntry {
  seq: number;
  method: string;
  path: string;
  query: Record<string, string>;
  status: number;
  body?: PrototypeRequestJson;
}

export interface MockBackendDeps {
  random: Random;
  ids: IdGenerator;
  timer: Pick<Timer, "sleep">;
}

const MAX_LOG_ENTRIES = 200;

export class PrototypeMockBackend {
  private readonly collections = new Map<string, MockItem[]>();
  private readonly faultHits = new Map<MockFault, number>();
  private readonly log: MockLogEntry[] = [];
  private seq = 0;

  constructor(
    private readonly definition: MockBackendDefinition,
    private readonly deps: MockBackendDeps,
  ) {
    for (const [name, items] of Object.entries(definition.collections ?? {})) {
      this.collections.set(name, structuredClone(items));
    }
  }

  /** Requests answered so far with `seq` above `since`, oldest first; bounded to the latest 200. */
  requestLog(since = 0): MockLogEntry[] {
    return this.log.filter((entry) => entry.seq > since);
  }

  /** Current collection contents, for assertions. */
  snapshot(): Record<string, MockItem[]> {
    return Object.fromEntries(
      [...this.collections].map(([name, items]) => [name, structuredClone(items)]),
    );
  }

  /**
   * Aborting `signal` while the answer waits on latency or a route delay ends it with the abort
   * reason before anything is written, so a cancelled or timed-out request never changes state.
   */
  async answer(request: MockRequest, signal?: AbortSignal): Promise<MockResponse> {
    const method = request.method.toUpperCase();
    await this.waitLatency();
    signal?.throwIfAborted();
    const response = this.faultFor(method, request.path) ??
      (await this.cannedRoute(method, request, signal)) ??
      this.collectionResponse(method, request) ?? {
        status: 404,
        headers: {},
        body: { error: "No such route" },
      };
    this.record(method, request, response);
    return response;
  }

  private async waitLatency(): Promise<void> {
    const latency = this.definition.latencyMs;
    if (latency === undefined) {
      return;
    }
    const wait =
      latency.min + Math.floor(this.deps.random.next() * (latency.max - latency.min + 1));
    if (wait > 0) {
      await this.deps.timer.sleep(wait);
    }
  }

  private faultFor(method: string, path: string): MockResponse | undefined {
    for (const fault of this.definition.faults ?? []) {
      if (
        (fault.method !== undefined && fault.method !== method) ||
        !matchMockPath(fault.path, path)
      ) {
        continue;
      }
      const hits = (this.faultHits.get(fault) ?? 0) + 1;
      this.faultHits.set(fault, hits);
      const fires =
        fault.every !== undefined
          ? hits % fault.every === 0
          : this.deps.random.next() < fault.rate!;
      if (fires) {
        return { status: fault.status, headers: {}, body: { error: "mock fault" } };
      }
    }
    return undefined;
  }

  private async cannedRoute(
    method: string,
    request: MockRequest,
    signal: AbortSignal | undefined,
  ): Promise<MockResponse | undefined> {
    for (const route of this.definition.routes ?? []) {
      const params = route.method === method ? matchMockPath(route.path, request.path) : undefined;
      if (params !== undefined) {
        return this.routeResponse(
          route,
          { params, query: request.query, body: request.body },
          signal,
        );
      }
    }
    return undefined;
  }

  private async routeResponse(
    route: MockRoute,
    context: Parameters<typeof bindMockValue>[1],
    signal: AbortSignal | undefined,
  ): Promise<MockResponse> {
    if (route.delayMs !== undefined && route.delayMs > 0) {
      await this.deps.timer.sleep(route.delayMs);
      signal?.throwIfAborted();
    }
    return {
      status: route.status ?? 200,
      headers: route.headers ?? {},
      body: route.body === undefined ? null : bindMockValue(route.body, context),
    };
  }

  private collectionResponse(method: string, request: MockRequest): MockResponse | undefined {
    // The path keeps its percent-encoding; names and ids are compared decoded, like route params.
    const [, name, ...rest] = request.path.split("/").map(decodeURIComponentSafe);
    const items = name === undefined ? undefined : this.collections.get(name);
    if (items === undefined) {
      return undefined;
    }
    return answerCollection(
      items,
      { method, rest, query: request.query, body: request.body },
      { ids: this.deps.ids, fits: (next) => this.fitsWith(items, next) },
    );
  }

  /** The whole backend (every collection and the routes) must stay within one budget. */
  private fitsWith(items: MockItem[], next: MockItem[]): boolean {
    const collections = Object.fromEntries(
      [...this.collections].map(([name, current]) => [name, current === items ? next : current]),
    );
    return (
      Buffer.byteLength(JSON.stringify([collections, this.definition.routes])) <=
      MAX_MOCK_BACKEND_BYTES
    );
  }

  private record(method: string, request: MockRequest, response: MockResponse): void {
    this.log.push({
      seq: ++this.seq,
      method,
      path: request.path,
      query: request.query,
      status: response.status,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    if (this.log.length > MAX_LOG_ENTRIES) {
      this.log.shift();
    }
  }
}
