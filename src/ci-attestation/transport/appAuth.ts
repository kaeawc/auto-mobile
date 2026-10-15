import { sign } from "node:crypto";
import type { FetchLike } from "../../features/webrtc/WhipClient";
import { ActionableError } from "../../models";
import { fixedBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { TransportConfig } from "./config";
import {
  isRecord,
  type Clock,
  type InstallationTokenProvider,
  type InstallationTokenPurpose,
} from "./types";

const MAX_RESPONSE_BYTES = 65_536;

export interface JwtSigner {
  sign(input: string, privateKey: string): string;
}

export class RsaJwtSigner implements JwtSigner {
  sign(input: string, privateKey: string): string {
    return sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
  }
}

export type TransportFailureReason =
  | "transport-unavailable"
  | "invalid-response"
  | "unauthenticated";

/** Only fixed, credential-free messages cross the transport boundary. */
export class TransportFailure extends ActionableError {
  constructor(
    readonly reason: TransportFailureReason,
    readonly retryable = false,
  ) {
    super(`Attestation transport failed: ${reason}. Run the job for real.`);
  }
}

export interface HttpOptions {
  fetchImpl?: FetchLike;
  timer?: Timer;
  timeoutMs?: number;
}

/** Shared bounded HTTP boundary; the deadline includes reading the response body. */
export class TransportHttpClient {
  readonly timer: Timer;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: HttpOptions = {}) {
    this.timer = options.timer ?? defaultTimer;
    // FetchLike has no redirect field. The native adapter rejects redirects;
    // injected adapters must enforce the same rule (see the setup document).
    this.fetchImpl = options.fetchImpl ?? ((url, init) => this.nativeFetch(url, init));
    const timeout = options.timeoutMs ?? 10_000;
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 10_000) : 10_000;
  }

  private async nativeFetch(url: string, init: Parameters<FetchLike>[1]) {
    const response = await globalThis.fetch(url, { ...init, redirect: "error" });
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      text: () => this.readNativeBody(response),
    };
  }

  private async readNativeBody(response: Response): Promise<string> {
    if (!response.body) {
      return "";
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return Buffer.concat(chunks, bytes).toString("utf8");
        }
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new TransportFailure("invalid-response");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  async deadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    return raceWithDeadline(() => operation(controller.signal), {
      timer: this.timer,
      timeoutMs: this.timeoutMs,
      label: "Attestation request",
      timeoutError: () => new TransportFailure("transport-unavailable"),
      onTimeout: () => controller.abort(),
    });
  }

  async request(url: string, init: Parameters<FetchLike>[1]): Promise<unknown> {
    try {
      return await this.deadline(async (signal) => {
        const response = await this.fetchImpl(url, { ...init, signal });
        if (response.status === 401 || response.status === 403) {
          throw new TransportFailure("unauthenticated");
        }
        if (!response.ok) {
          throw new TransportFailure(
            "transport-unavailable",
            response.status === 429 || response.status >= 500,
          );
        }
        const length = Number(response.headers.get("content-length"));
        if (length > MAX_RESPONSE_BYTES) {
          throw new TransportFailure("invalid-response");
        }
        const body = await response.text();
        if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
          throw new TransportFailure("invalid-response");
        }
        return this.parse(body);
      });
    } catch (error) {
      logger.warn("Attestation HTTP request failed; response and credentials withheld.");
      if (error instanceof TransportFailure) {
        throw error;
      }
      throw new TransportFailure("transport-unavailable", true);
    }
  }

  private parse(body: string): unknown {
    try {
      return JSON.parse(body);
    } catch {
      logger.warn("Attestation response is not JSON; response withheld.");
      throw new TransportFailure("invalid-response");
    }
  }
}

export function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "AutoMobile-attestation-transport",
  };
}

interface TokenEntry {
  token: string;
  refreshAt: number;
}

export interface AppAuthOptions extends HttpOptions {
  config: TransportConfig;
  clock: Clock;
  signer?: JwtSigner;
  backoff?: BackoffPolicy;
}

export class GitHubAppTokenProvider implements InstallationTokenProvider {
  readonly #http: TransportHttpClient;
  readonly #signer: JwtSigner;
  readonly #backoff: BackoffPolicy;
  readonly #cache = new Map<string, TokenEntry>();
  readonly #inFlight = new Map<string, Promise<string>>();
  readonly #options: AppAuthOptions;

  constructor(options: AppAuthOptions) {
    this.#options = options;
    this.#http = new TransportHttpClient(options);
    this.#signer = options.signer ?? new RsaJwtSigner();
    this.#backoff = options.backoff ?? fixedBackoff(100);
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "GitHubAppTokenProvider";
  }

  toJSON(): string {
    return "GitHubAppTokenProvider";
  }

  async getInstallationToken(
    owner: string,
    repo: string,
    purpose: InstallationTokenPurpose,
  ): Promise<string> {
    try {
      return await this.cachedOrAcquire(owner, repo, purpose);
    } catch (error) {
      logger.warn("GitHub App authentication failed; credentials and response withheld.");
      if (error instanceof TransportFailure) {
        throw error;
      }
      throw new TransportFailure("unauthenticated");
    }
  }

  private async cachedOrAcquire(
    owner: string,
    repo: string,
    purpose: InstallationTokenPurpose,
  ): Promise<string> {
    const key = JSON.stringify([owner, repo, purpose]);
    const cached = this.#cache.get(key);
    if (cached && this.#options.clock.nowMs() < cached.refreshAt) {
      return cached.token;
    }
    const pending = this.#inFlight.get(key);
    if (pending) {
      return pending;
    }
    const request = this.acquire(owner, repo, purpose, key);
    this.#inFlight.set(key, request);
    try {
      return await request;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  private jwt(): string {
    const now = Math.floor(this.#options.clock.nowMs() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.#options.config.appId }),
    ).toString("base64url");
    const input = `${header}.${payload}`;
    return `${input}.${this.#signer.sign(input, this.#options.config.privateKey)}`;
  }

  private async acquire(
    owner: string,
    repo: string,
    purpose: InstallationTokenPurpose,
    key: string,
  ): Promise<string> {
    const jwt = this.jwt();
    const id = this.#options.config.installationId ?? (await this.installationId(owner, repo, jwt));
    const response = await this.githubRequest(
      `/app/installations/${encodeURIComponent(id)}/access_tokens`,
      jwt,
      {
        permissions:
          purpose === "checks" ? { metadata: "read", checks: "write" } : { metadata: "read" },
        repositories: [repo],
      },
    );
    const entry = this.tokenEntry(response);
    this.#cache.set(key, entry);
    return entry.token;
  }

  private tokenEntry(response: unknown): TokenEntry {
    if (
      !isRecord(response) ||
      typeof response.token !== "string" ||
      !response.token.trim() ||
      typeof response.expires_at !== "string"
    ) {
      throw new TransportFailure("invalid-response");
    }
    const expiresAt = Date.parse(response.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.#options.clock.nowMs()) {
      throw new TransportFailure("invalid-response");
    }
    return { token: response.token, refreshAt: expiresAt - 300_000 };
  }

  private async installationId(owner: string, repo: string, jwt: string): Promise<string> {
    const response = await this.githubRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      jwt,
    );
    if (!isRecord(response) || !Number.isSafeInteger(response.id) || Number(response.id) <= 0) {
      throw new TransportFailure("invalid-response");
    }
    return String(response.id);
  }

  private async githubRequest(path: string, jwt: string, body?: unknown): Promise<unknown> {
    const url = `${this.#options.config.githubApiUrl}${path}`;
    const init = {
      method: body === undefined ? "GET" : "POST",
      headers: githubHeaders(jwt),
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    try {
      return await this.#http.request(url, init);
    } catch (error) {
      logger.warn("GitHub App request failed; considering one bounded retry.");
      if (!(error instanceof TransportFailure) || !error.retryable) {
        throw error;
      }
      const delay = this.#backoff.delayForAttempt(1);
      await this.#http.timer.sleep(
        Number.isFinite(delay) ? Math.max(0, Math.min(delay, 1000)) : 100,
      );
      return this.#http.request(url, init);
    }
  }
}
