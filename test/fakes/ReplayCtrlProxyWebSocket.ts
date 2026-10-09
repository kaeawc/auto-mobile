import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Timer } from "../../src/utils/SystemTimer";
import { FakeWebSocket } from "./FakeWebSocket";

/**
 * Replays iOS CtrlProxy exchanges captured by `CtrlProxyExchangeRecorder`
 * (`AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR`, issue #5837) to a real
 * `IOSCtrlProxyClient` in unit tests.
 *
 * On open the socket emits every recorded `push-connected` handshake. Each
 * request the client sends is answered with the next unserved recorded exchange
 * of the same `type`, with the live `requestId` substituted. A request with no
 * recorded exchange left is kept in `unmatchedRequests` and gets no reply, so a
 * test should assert that list is empty.
 */
export interface RecordedExchange {
  fileName: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  push?: Record<string, unknown>;
}

export function loadRecordedExchanges(directory: string): RecordedExchange[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((fileName) => ({
      fileName,
      ...(JSON.parse(readFileSync(path.join(directory, fileName), "utf8")) as Omit<
        RecordedExchange,
        "fileName"
      >),
    }));
}

export class ReplayCtrlProxyWebSocket extends FakeWebSocket {
  readonly sentRequests: Record<string, unknown>[] = [];
  readonly unmatchedRequests: Record<string, unknown>[] = [];
  private readonly served = new Set<RecordedExchange>();

  constructor(
    url: string,
    private readonly exchanges: readonly RecordedExchange[],
    timer?: Timer,
  ) {
    super(url, "none", 0, timer);
    this.once("open", () => {
      for (const exchange of exchanges) {
        if (exchange.push?.type === "connected") {
          this.simulateMessage(JSON.stringify(exchange.push));
        }
      }
    });
  }

  override send(data: unknown): void {
    super.send(data);
    const request = JSON.parse(String(data)) as Record<string, unknown>;
    this.sentRequests.push(request);
    const exchange = this.exchanges.find(
      (candidate) =>
        !this.served.has(candidate) &&
        candidate.response !== undefined &&
        candidate.request?.type === request.type,
    );
    if (!exchange?.response) {
      this.unmatchedRequests.push(request);
      return;
    }
    this.served.add(exchange);
    const reply = { ...exchange.response, requestId: request.requestId };
    queueMicrotask(() => this.simulateMessage(JSON.stringify(reply)));
  }
}

export function createReplayWebSocketFactory(
  exchanges: readonly RecordedExchange[],
  timer?: Timer,
): { factory: (url: string) => ReplayCtrlProxyWebSocket; sockets: ReplayCtrlProxyWebSocket[] } {
  const sockets: ReplayCtrlProxyWebSocket[] = [];
  return {
    factory: (url: string) => {
      const socket = new ReplayCtrlProxyWebSocket(url, exchanges, timer);
      sockets.push(socket);
      return socket;
    },
    sockets,
  };
}
