import { logger } from "../../utils/logger";
import {
  TransportFailure,
  TransportHttpClient,
  type HttpOptions,
  type TransportFailureReason,
} from "./appAuth";
import type { TransportConfig } from "./config";
import {
  isAttestationDecision,
  isRecord,
  type AttestationDecision,
  type AttestationDecisionSource,
  type AttestationQuery,
  type AttestationUploader,
  type AttestationUploadRequest,
  type AttestationUploadResult,
  type InstallationTokenProvider,
} from "./types";

export interface ServiceClientOptions extends HttpOptions {
  config: Pick<TransportConfig, "serviceUrl">;
  tokenProvider?: InstallationTokenProvider;
  /** Uploads need repository identity to obtain a scoped installation token. */
  owner: string;
  repo: string;
}

function failureReason(error: unknown): TransportFailureReason {
  return error instanceof TransportFailure ? error.reason : "transport-unavailable";
}

function validateHash(inputHash: string): void {
  if (inputHash.length !== 64 || !/^[a-f0-9]{64}$/.test(inputHash)) {
    throw new TransportFailure("invalid-response");
  }
}

export class AttestationServiceClient implements AttestationUploader, AttestationDecisionSource {
  readonly #http: TransportHttpClient;
  readonly #options: ServiceClientOptions;

  constructor(options: ServiceClientOptions) {
    this.#options = options;
    this.#http = new TransportHttpClient(options);
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "AttestationServiceClient";
  }

  toJSON(): string {
    return "AttestationServiceClient";
  }

  async decide(query: AttestationQuery): Promise<AttestationDecision> {
    try {
      validateHash(query.inputHash);
      const response = await this.request("/v1/decisions", "POST", query, query);
      if (!isAttestationDecision(response)) {
        throw new TransportFailure("invalid-response");
      }
      // Arbitrary service detail could echo credentials. Only the finite decision
      // vocabulary crosses into logs, CI outputs, and PR surfaces.
      return { kind: response.kind, reason: response.reason };
    } catch (error) {
      logger.warn("Attestation decision unavailable; run the job for real.");
      return { kind: "ignore", reason: failureReason(error) };
    }
  }

  async upload(req: AttestationUploadRequest): Promise<AttestationUploadResult> {
    try {
      validateHash(req.inputHash);
      const response = await this.request(
        `/v1/attestations/${req.inputHash}`,
        "PUT",
        {
          tier: req.tier,
          envelope: req.envelope,
        },
        this.#options,
      );
      if (
        !isRecord(response) ||
        response.ok !== true ||
        (response.id !== undefined && typeof response.id !== "string")
      ) {
        throw new TransportFailure("invalid-response");
      }
      // The optional remote ID is opaque and may echo credentials; omit it.
      return { ok: true };
    } catch (error) {
      logger.warn("Attestation upload failed; response and credentials withheld.");
      return { ok: false, reason: failureReason(error) };
    }
  }

  private async request(
    path: string,
    method: string,
    body: unknown,
    repository: { owner: string; repo: string },
  ): Promise<unknown> {
    const token = await this.token(repository);
    return this.#http.request(`${this.#options.config.serviceUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async token(repository: { owner: string; repo: string }): Promise<string> {
    try {
      const token = await this.#http.deadline(
        () =>
          this.#options.tokenProvider?.getInstallationToken(
            repository.owner,
            repository.repo,
            "service",
          ) ?? Promise.resolve(""),
      );
      if (!token.trim()) {
        throw new TransportFailure("unauthenticated");
      }
      return token;
    } catch (error) {
      logger.warn("Attestation service authentication unavailable; credentials withheld.");
      if (error instanceof TransportFailure) {
        throw error;
      }
      throw new TransportFailure("unauthenticated");
    }
  }
}
