import { logger } from "./logger";
import { Timer, defaultTimer } from "./SystemTimer";
import { randomUUID } from "node:crypto";

/**
 * Represents a pending request with timeout handling.
 */
interface PendingRequest<T> {
  id: string;
  type: string;
  resolve: (result: T) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<Timer["setTimeout"]>;
  createdAt: number;
  responseErrorFactory?: ResponseErrorFactory<T>;
}

/**
 * Default error result factory for timed-out requests.
 */
type TimeoutErrorFactory<T> = (requestId: string, type: string, timeoutMs: number) => T;

/**
 * Error result factory for responses that fail before the expected result type is emitted.
 */
type ResponseErrorFactory<T> = (error: string, totalTimeMs: number) => T;

/**
 * Manages pending requests with automatic timeout handling.
 *
 * This solves the problem where:
 * 1. Single pending field per request type can't handle concurrent requests
 * 2. Timeout callbacks need proper cleanup when responses arrive
 * 3. Request ID matching needs to be robust
 *
 * Each request is tracked by its unique ID, allowing multiple concurrent
 * requests of the same type without conflicts.
 */
export class RequestManager {
  private pending: Map<string, PendingRequest<unknown>> = new Map();
  private timer: Timer;

  constructor(timer: Timer = defaultTimer) {
    this.timer = timer;
  }

  /**
   * Generate a unique request ID.
   * @param type - The request type (e.g., "screenshot", "swipe")
   * @returns Unique request ID
   */
  generateId(type: string): string {
    // Request managers are deliberately per client. A time + per-instance counter
    // collides when two daemon clients issue the same request in the same tick, and
    // CtrlProxy uses the ID to select the response owner. A UUID keeps that routing
    // boundary safe across clients as well as across reconnects.
    return `${type}_${randomUUID()}`;
  }

  /**
   * Register a pending request with automatic timeout.
   * @param id - Unique request ID
   * @param type - Request type for logging
   * @param timeoutMs - Timeout in milliseconds
   * @param timeoutErrorFactory - Factory to create error result on timeout
   * @returns Promise that resolves with the response or times out
   */
  register<T>(
    id: string,
    type: string,
    timeoutMs: number,
    timeoutErrorFactory: TimeoutErrorFactory<T>,
    responseErrorFactory?: ResponseErrorFactory<T>,
  ): Promise<T> {
    const promise = new Promise<T>((resolve, reject) => {
      // Set up timeout
      const timeoutId = this.timer.setTimeout(() => {
        const request = this.pending.get(id);
        if (request) {
          this.pending.delete(id);
          logger.warn(
            `[RequestManager] Request timed out: ${type} (id: ${id}, timeout: ${timeoutMs}ms)`,
          );
          resolve(timeoutErrorFactory(id, type, timeoutMs));
        }
      }, timeoutMs);

      // Store pending request
      this.pending.set(id, {
        id,
        type,
        resolve: resolve as (result: unknown) => void,
        reject,
        timeoutId,
        createdAt: this.timer.now(),
        responseErrorFactory: responseErrorFactory as ResponseErrorFactory<unknown> | undefined,
      });

      logger.debug(
        `[RequestManager] Registered request: ${type} (id: ${id}, timeout: ${timeoutMs}ms)`,
      );
    });
    // A caller can fail synchronously while writing the just-registered request
    // to a WebSocket. Keep that abandoned promise observed until the caller's
    // error path cancels it or its timeout resolves; otherwise close() turns a
    // send failure into an unhandled rejection.
    void promise.catch(() => {});
    return promise;
  }

  /**
   * Resolve a pending request with a result.
   * @param id - The request ID
   * @param result - The result to resolve with
   * @returns true if request was found and resolved, false if not found (already timed out or invalid ID)
   */
  resolve<T>(id: string, result: T): boolean {
    const request = this.pending.get(id);
    if (!request) {
      logger.debug(`[RequestManager] No pending request found for id: ${id} (may have timed out)`);
      return false;
    }

    // Cancel the timeout
    this.timer.clearTimeout(request.timeoutId);

    // Remove from pending
    this.pending.delete(id);

    // Resolve the promise
    const duration = this.timer.now() - request.createdAt;
    logger.debug(
      `[RequestManager] Resolved request: ${request.type} (id: ${id}, duration: ${duration}ms)`,
    );
    request.resolve(result);

    return true;
  }

  /**
   * Resolve a pending request with an error response, preserving request-specific
   * result shape when the caller registered an error result factory.
   */
  resolveError(id: string, error: string, totalTimeMs: number = 0): boolean {
    const request = this.pending.get(id);
    if (!request) {
      logger.debug(`[RequestManager] No pending request found for id: ${id} (may have timed out)`);
      return false;
    }

    this.timer.clearTimeout(request.timeoutId);
    this.pending.delete(id);

    const result = request.responseErrorFactory
      ? request.responseErrorFactory(error, totalTimeMs)
      : { success: false, totalTimeMs, error };
    const duration = this.timer.now() - request.createdAt;
    logger.debug(
      `[RequestManager] Resolved errored request: ${request.type} (id: ${id}, duration: ${duration}ms)`,
    );
    request.resolve(result);

    return true;
  }

  /**
   * Reject a pending request with an error.
   * @param id - The request ID
   * @param error - The error to reject with
   * @returns true if request was found and rejected, false if not found
   */
  reject(id: string, error: Error): boolean {
    const request = this.pending.get(id);
    if (!request) {
      return false;
    }

    // Cancel the timeout
    this.timer.clearTimeout(request.timeoutId);

    // Remove from pending
    this.pending.delete(id);

    // Reject the promise
    logger.debug(
      `[RequestManager] Rejected request: ${request.type} (id: ${id}, error: ${error.message})`,
    );
    request.reject(error);

    return true;
  }

  /**
   * Check if a request is pending.
   * @param id - The request ID
   */
  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  /**
   * Get the number of pending requests.
   */
  getPendingCount(): number {
    return this.pending.size;
  }

  /**
   * Get all pending request IDs (for debugging).
   */
  getPendingIds(): string[] {
    return Array.from(this.pending.keys());
  }

  /**
   * Cancel all pending requests.
   * Call this when closing the connection.
   */
  cancelAll(error: Error = new Error("All requests cancelled")): void {
    const count = this.pending.size;
    for (const request of this.pending.values()) {
      this.timer.clearTimeout(request.timeoutId);
      request.reject(error);
    }
    this.pending.clear();
    if (count > 0) {
      logger.info(`[RequestManager] Cancelled ${count} pending requests`);
    }
  }

  /**
   * Reset the request manager (for testing).
   * Unlike cancelAll(), this silently clears pending requests without rejecting them.
   */
  reset(): void {
    // Just clear timeouts and remove entries without rejecting
    // This avoids unhandled rejection errors in tests
    for (const request of this.pending.values()) {
      this.timer.clearTimeout(request.timeoutId);
    }
    this.pending.clear();
    this.requestCounter = 0;
  }
}
