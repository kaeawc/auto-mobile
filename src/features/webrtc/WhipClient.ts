import { ActionableError } from "../../models";
import { logger } from "../../utils/logger";

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
  }
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
}

export interface WhipSession {
  /** SDP answer returned by the ingest server. */
  answerSdp: string;
  /**
   * Absolute resource URL for this ingest session (from the `Location` header),
   * used to terminate — and, by extension, reconnect (re-publish) — the stream.
   */
  resourceUrl: string | null;
}

/**
 * Client for the WebRTC-HTTP Ingestion Protocol (WHIP, draft-ietf-wish-whip).
 * The publisher POSTs an SDP offer and receives an SDP answer plus a resource
 * URL; DELETE on that URL tears the session down. Reconnection is a fresh
 * `publish()` (optionally after DELETEing the stale resource).
 */
export class WhipClient {
  private readonly endpoint: string;
  private readonly bearerToken?: string;
  private readonly fetchImpl: FetchLike;

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
  }

  /** POST the SDP offer to the ingest endpoint; returns the answer + resource URL. */
  async publish(offerSdp: string, signal?: AbortSignal): Promise<WhipSession> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/sdp" }),
      body: offerSdp,
      signal,
    });

    if (response.status !== 201) {
      const detail = await this.safeText(response);
      throw new ActionableError(
        `WHIP ingest failed: expected 201 Created, got ${response.status}${detail ? ` — ${detail}` : ""}`
      );
    }

    const answerSdp = await response.text();
    if (!answerSdp.trim()) {
      throw new ActionableError("WHIP ingest returned an empty SDP answer.");
    }

    const location = response.headers.get("location");
    const resourceUrl = location ? this.resolveLocation(location) : null;
    if (!resourceUrl) {
      logger.warn("[WHIP] Ingest response omitted a Location header; reconnect/teardown will re-POST.");
    }

    return { answerSdp, resourceUrl };
  }

  /**
   * PATCH a trickle-ICE SDP fragment to the session resource (WHIP trickle
   * extension, `application/trickle-ice-sdpfrag`). Best-effort: a server that
   * does not support trickle answers 405/501 and the publisher keeps the
   * candidates it already sent in the offer.
   */
  async patchCandidate(
    resourceUrl: string,
    sdpFragment: string,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await this.fetchImpl(resourceUrl, {
      method: "PATCH",
      headers: this.headers({ "Content-Type": "application/trickle-ice-sdpfrag" }),
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
    const response = await this.fetchImpl(resourceUrl, {
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

  private resolveLocation(location: string): string {
    try {
      return new URL(location, this.endpoint).toString();
    } catch {
      logger.warn(`[WHIP] Could not resolve Location header "${location}" against ${this.endpoint}`);
      return location;
    }
  }

  private async safeText(response: { text(): Promise<string> }): Promise<string> {
    try {
      return (await response.text()).slice(0, 300);
    } catch (error) {
      logger.debug(`[WHIP] failed to read error response body: ${error}`);
      return "";
    }
  }
}
