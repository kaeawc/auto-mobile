import { ActionableError } from "../../models";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";

export const DEFAULT_WHIP_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Minimal `fetch` surface used by the WHIP client, so tests can inject a fake
 * without a real HTTP server. Matches the global `fetch` signature we rely on.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface WhipClientOptions {
  /** WHIP ingest endpoint URL (absolute). */
  endpoint: string;
  /** Optional bearer token sent as `Authorization: Bearer <token>`. */
  bearerToken?: string;
  fetchImpl?: FetchLike;
  /** Bound a stalled WHIP endpoint so start/stop/reconnect cannot hang forever. */
  requestTimeoutMs?: number;
  timer?: Timer;
}

export interface WhipSession {
  /** SDP answer returned by the ingest server. */
  answerSdp: string;
  /**
   * Absolute resource URL for this ingest session (from the `Location` header),
   * used to terminate — and, by extension, reconnect (re-publish) — the stream.
   */
  resourceUrl: string | null;
  /** Strong entity tag for conditional Trickle-ICE PATCH requests. */
  etag: string | null;
}

/**
 * Client for the WebRTC-HTTP Ingestion Protocol (WHIP, RFC 9725).
 * The publisher POSTs an SDP offer and receives an SDP answer plus a resource
 * URL; DELETE on that URL tears the session down. Reconnection is a fresh
 * `publish()` (optionally after DELETEing the stale resource).
 *
 * Specification: https://www.rfc-editor.org/rfc/rfc9725.html
 * - setup and `201 Created` / `Location`: §4.2
 * - trickle-ICE PATCH: §4.3
 * - DELETE session termination: §4.2
 * - bearer authentication: §4.7
 */
export class WhipClient {
  private readonly endpoint: string;
  private readonly bearerToken?: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;
  private readonly timer: Timer;

  constructor(options: WhipClientOptions) {
    if (!options.endpoint) {
      throw new ActionableError("WHIP endpoint URL is required.");
    }
    this.endpoint = options.endpoint;
    this.bearerToken = options.bearerToken;
    // eslint-disable-next-line auto-mobile/no-unknown-cast -- global fetch's lib.dom types are wider than the narrow FetchLike we call (url,{method,headers,body,signal}) -> {status,ok,headers.get,text}.
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!this.fetchImpl) {
      throw new ActionableError("No fetch implementation available for WHIP client.");
    }
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_WHIP_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new ActionableError("WHIP request timeout must be a positive number of milliseconds.");
    }
    this.timer = options.timer ?? defaultTimer;
  }

  /** POST the SDP offer to the ingest endpoint; returns the answer + resource URL. */
  async publish(offerSdp: string, signal?: AbortSignal): Promise<WhipSession> {
    const response = await this.fetchWithTimeout(this.endpoint, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/sdp" }),
      body: offerSdp,
      signal,
    });

    if (response.status !== 201) {
      const detail = await this.safeText(response);
      throw new ActionableError(
        `WHIP ingest failed: expected 201 Created, got ${response.status}${detail ? ` — ${detail}` : ""}`,
      );
    }

    const answerSdp = await this.readTextWithTimeout(response, "POST");
    if (!answerSdp.trim()) {
      throw new ActionableError("WHIP ingest returned an empty SDP answer.");
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new ActionableError("WHIP ingest response omitted the required Location header.");
    }
    const resourceUrl = this.resolveLocation(location);
    const etag = response.headers.get("etag");

    return { answerSdp, resourceUrl, etag };
  }

  /**
   * PATCH a trickle-ICE SDP fragment to the session resource (WHIP trickle
   * extension, `application/trickle-ice-sdpfrag`). Best-effort: a server that
   * does not support trickle answers 405/501 and the publisher keeps the
   * candidates it already sent in the offer.
   */
  async patchCandidate(
    resourceUrl: string,
    etag: string,
    sdpFragment: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.fetchWithTimeout(resourceUrl, {
      method: "PATCH",
      headers: this.headers({
        "Content-Type": "application/trickle-ice-sdpfrag",
        "If-Match": etag,
      }),
      body: sdpFragment,
      signal,
    });
    // 204 No Content is the success case; 200 is tolerated. Anything else is a
    // server that does not implement trickle — log and move on.
    if (response.status !== 204 && response.status !== 200) {
      logger.debug(`[WHIP] trickle PATCH ${resourceUrl} returned ${response.status}`);
    }
  }

  /** DELETE the ingest resource to terminate the session (best-effort). */
  async delete(resourceUrl: string, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchWithTimeout(resourceUrl, {
      method: "DELETE",
      headers: this.headers(),
      signal,
    });
    if (!response.ok && response.status !== 404) {
      logger.warn(`[WHIP] DELETE ${resourceUrl} returned ${response.status}`);
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.bearerToken) {
      headers["Authorization"] = `Bearer ${this.bearerToken}`;
    }
    return headers;
  }

  private async fetchWithTimeout(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<Awaited<ReturnType<FetchLike>>> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (init.signal?.aborted) {
      controller.abort();
    } else {
      init.signal?.addEventListener("abort", onAbort, { once: true });
    }
    const timeout = this.timer.setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && !init.signal?.aborted) {
        throw new ActionableError(
          `WHIP ${init.method} request timed out after ${this.requestTimeoutMs}ms.`,
        );
      }
      throw error;
    } finally {
      this.timer.clearTimeout(timeout);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  private resolveLocation(location: string): string {
    try {
      return new URL(location, this.endpoint).toString();
    } catch {
      logger.warn(
        `[WHIP] Could not resolve Location header "${location}" against ${this.endpoint}`,
      );
      return location;
    }
  }

  private async safeText(response: { text(): Promise<string> }): Promise<string> {
    try {
      return (await this.readTextWithTimeout(response, "response")).slice(0, 300);
    } catch (error) {
      logger.debug(`[WHIP] failed to read error response body: ${error}`);
      return "";
    }
  }

  /** Keep the request deadline in force when a peer stalls after HTTP headers. */
  private async readTextWithTimeout(
    response: { text(): Promise<string> },
    method: string,
  ): Promise<string> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        response.text(),
        new Promise<never>((_, reject) => {
          timeout = this.timer.setTimeout(
            () =>
              reject(
                new ActionableError(
                  `WHIP ${method} response body timed out after ${this.requestTimeoutMs}ms.`,
                ),
              ),
            this.requestTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeout) {
        this.timer.clearTimeout(timeout);
      }
    }
  }
}
