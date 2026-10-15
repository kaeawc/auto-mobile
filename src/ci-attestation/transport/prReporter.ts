import { logger } from "../../utils/logger";
import { githubHeaders, TransportHttpClient, type HttpOptions } from "./appAuth";
import type { TransportConfig } from "./config";
import {
  isAttestationDecision,
  type AttestationDecision,
  type AttestationDecisionReason,
  type InstallationTokenProvider,
} from "./types";

export const decisionReasonText: Record<AttestationDecisionReason, string> = {
  "verified-match": "The service verified a matching attestation.",
  "no-attestation": "No attestation is available.",
  "hash-mismatch": "The attestation input hash does not match.",
  stale: "The attestation is stale.",
  "env-mismatch": "The attestation environment does not match.",
  "policy-tier": "Service policy requires work for this tier.",
  "transport-unavailable": "The attestation transport is unavailable; run the job for real.",
  "invalid-response": "The attestation response is invalid; run the job for real.",
  unauthenticated: "Attestation authentication is unavailable; run the job for real.",
};

export interface DecisionReport {
  owner: string;
  repo: string;
  sha: string;
  tier: number;
  decision: AttestationDecision;
}

export interface DecisionReporter {
  report(report: DecisionReport): Promise<void>;
}

export interface PrReporterOptions extends HttpOptions {
  config: Pick<TransportConfig, "githubApiUrl">;
  tokenProvider: InstallationTokenProvider;
}

/** Informational checks are never read as authoritative attestation state. */
export class PrDecisionReporter implements DecisionReporter {
  private readonly http: TransportHttpClient;

  constructor(private readonly options: PrReporterOptions) {
    this.http = new TransportHttpClient(options);
  }

  async report(report: DecisionReport): Promise<void> {
    try {
      if (
        !isAttestationDecision(report.decision) ||
        !Number.isSafeInteger(report.tier) ||
        report.tier < 1 ||
        report.tier > 3 ||
        typeof report.sha !== "string" ||
        (report.sha.length !== 40 && report.sha.length !== 64) ||
        !/^[a-f0-9]+$/.test(report.sha)
      ) {
        logger.warn("Attestation check report invalid; nothing sent.");
        return;
      }
      const token = await this.http.deadline(() =>
        this.options.tokenProvider.getInstallationToken(report.owner, report.repo, "checks"),
      );
      if (!token.trim()) {
        logger.warn("Attestation check reporting unavailable; authentication missing.");
        return;
      }
      const { decision } = report;
      const description = `${decision.kind}: ${decisionReasonText[decision.reason]}`;
      await this.http.request(
        `${this.options.config.githubApiUrl}/repos/${encodeURIComponent(report.owner)}/${encodeURIComponent(report.repo)}/check-runs`,
        {
          method: "POST",
          headers: githubHeaders(token),
          body: JSON.stringify({
            name: `attestation / tier-${report.tier}`,
            head_sha: report.sha,
            status: "completed",
            conclusion: decision.kind === "skip" ? "success" : "neutral",
            output: { title: description, summary: description },
          }),
        },
      );
    } catch {
      logger.warn("Attestation check reporting failed; decision unchanged; credentials withheld.");
    }
  }
}
