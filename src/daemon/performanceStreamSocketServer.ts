import { Timer, defaultTimer } from "../utils/SystemTimer";
import { RequestResponseSocketServer, getSocketPath } from "./socketServer/index";
import { PerformanceAuditRepository } from "../db/performanceAuditRepository";
import {
  PerformanceStreamSocketRequest,
  PerformanceStreamSocketResponse,
} from "./performanceStreamSocketTypes";
import { PERFORMANCE_STREAM_SOCKET_CONFIG } from "./daemonFiles";
import {
  normalizeStreamLimit,
  normalizeStreamSinceId,
  normalizeStreamTimestampIso,
} from "./streamQueryNormalizers";

const DEFAULT_LIMIT = 200;

/**
 * Narrow view of {@link PerformanceAuditRepository} — exactly the query method the
 * handler calls. Injected via the constructor so tests can exercise the request
 * handler with a fake and never resolve the real file-backed database (issue #3067).
 */
export type PerformanceStreamRepository = Pick<PerformanceAuditRepository, "listResultsSince">;

/**
 * Socket server for performance stream polling.
 * Handles poll command to retrieve performance audit results.
 */
export class PerformanceStreamSocketServer extends RequestResponseSocketServer<
  PerformanceStreamSocketRequest,
  PerformanceStreamSocketResponse
> {
  private readonly auditRepository: PerformanceStreamRepository;

  constructor(
    socketPath: string = getSocketPath(PERFORMANCE_STREAM_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    auditRepository: PerformanceStreamRepository = new PerformanceAuditRepository(),
  ) {
    super(socketPath, timer, "PerformanceStream");
    this.auditRepository = auditRepository;
  }

  protected async handleRequest(
    request: PerformanceStreamSocketRequest,
  ): Promise<PerformanceStreamSocketResponse> {
    if (request.command !== "poll") {
      throw new Error(`Unsupported performance stream command: ${String(request.command)}`);
    }

    const startTime = normalizeStreamTimestampIso(request.startTime, "startTime");
    const endTime = normalizeStreamTimestampIso(request.endTime, "endTime");
    const sinceTimestamp = normalizeStreamTimestampIso(request.sinceTimestamp, "sinceTimestamp");
    const sinceId = normalizeStreamSinceId(request.sinceId);
    const limit = normalizeStreamLimit(request.limit, DEFAULT_LIMIT);

    const results = await this.auditRepository.listResultsSince({
      startTime,
      endTime,
      limit,
      deviceId: request.deviceId?.trim() || undefined,
      sessionId: request.sessionId?.trim() || undefined,
      packageName: request.packageName?.trim() || undefined,
      sinceTimestamp,
      sinceId,
    });

    const last = results.length > 0 ? results[results.length - 1] : undefined;

    return {
      success: true,
      results,
      lastTimestamp: last?.timestamp ?? sinceTimestamp,
      lastId: last?.id ?? sinceId,
    };
  }

  protected createErrorResponse(
    _id: string | undefined,
    error: string,
  ): PerformanceStreamSocketResponse {
    return {
      success: false,
      error,
    };
  }
}

let socketServer: PerformanceStreamSocketServer | null = null;

export function getPerformanceStreamSocketPath(): string {
  return socketServer?.getSocketPath() ?? getSocketPath(PERFORMANCE_STREAM_SOCKET_CONFIG);
}

export async function startPerformanceStreamSocketServer(): Promise<void> {
  if (!socketServer) {
    socketServer = new PerformanceStreamSocketServer();
  }
  if (!socketServer.isListening()) {
    await socketServer.start();
  }
}

export async function stopPerformanceStreamSocketServer(): Promise<void> {
  if (!socketServer) {
    return;
  }
  await socketServer.close();
  socketServer = null;
}
