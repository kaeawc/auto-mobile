import type { PerformanceAuditHistoryEntry } from "../db/performanceAuditRepository";
import type { SocketRequest } from "./socketServer/SocketServerTypes";

export interface PerformanceStreamSocketRequest extends SocketRequest {
  /** Live device or observer session UUID; required unless stream auth is disabled. */
  sessionUuid?: string;
  command: "poll";
  sinceTimestamp?: string;
  sinceId?: number;
  startTime?: string;
  endTime?: string;
  limit?: number;
  deviceId?: string;
  sessionId?: string;
  packageName?: string;
}

export interface PerformanceStreamSocketResponse {
  success: boolean;
  results?: PerformanceAuditHistoryEntry[];
  lastTimestamp?: string;
  lastId?: number;
  error?: string;
}
