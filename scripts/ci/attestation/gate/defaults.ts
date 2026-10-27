import { appendFile as nodeAppendFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../../../../src/utils/logger";
import { defaultTimer } from "../../../../src/utils/SystemTimer";
import type { Clock } from "../attestationSchema";
import { parseEnvelope } from "../attestationSchema";
import { GitTreeProbe } from "../gitTreeProbe";
import { LaneInputHasher } from "../produceAttestations";
import { CI_TARGET_ENV, CI_TARGET_PLATFORM } from "../tier1InputHash";
import { GitHubAppTokenProvider, type AppAuthOptions } from "../transport/appAuth";
import { loadTransportConfigFromEnv } from "../transport/config";
import { AttestationServiceClient } from "../transport/serviceClient";
import { isServiceDecision } from "../transport/types";
import { decideAttestation, defaultPolicy, type DecisionContext } from "../validators/trustPolicy";
import type { ShadowObservation } from "../shadow/types";
import type { AttestationTransport, InputHasher, ShadowRecorder, TierValidators } from "./ports";

export const unconfiguredTransport: AttestationTransport = {
  async fetch() {
    return { kind: "unavailable", reason: "attestation transport not configured" };
  },
};

export function serviceTransport(
  client: Pick<AttestationServiceClient, "lookup">,
): AttestationTransport {
  return {
    async fetch(query) {
      try {
        const [owner, repo, extra] = query.repo.split("/");
        if (!owner || !repo || extra !== undefined) {
          return { kind: "unavailable", reason: "invalid-repository" };
        }
        const result = await client.lookup({
          owner,
          repo,
          sha: query.commitSha,
          tier: query.tier,
          inputHash: query.inputHash,
        });
        if (!isServiceDecision(result.decision)) {
          return { kind: "unavailable", reason: "invalid-response" };
        }
        if (result.decision.reason === "no-attestation") {
          return { kind: "not-found" };
        }
        if (
          ["transport-unavailable", "invalid-response", "unauthenticated"].includes(
            result.decision.reason,
          )
        ) {
          return { kind: "unavailable", reason: result.decision.reason };
        }
        const parsed = parseEnvelope(result.envelope);
        if (!parsed.ok) {
          return { kind: "unavailable", reason: "invalid-response" };
        }
        return {
          kind: "found",
          attestation: {
            tier: parsed.envelope.payload.tier,
            claimedInputHash: parsed.envelope.payload.inputHash,
            raw: parsed.envelope,
            serviceDecision: result.decision,
          },
        };
      } catch (error) {
        // Remote diagnostics may contain credentials; only finite reasons escape this boundary.
        logger.warn("Attestation lookup unavailable; remote details withheld.");
        return { kind: "unavailable", reason: "transport-unavailable" };
      }
    },
  };
}

export function configuredTransport(
  env: Record<string, string | undefined>,
  options: Omit<AppAuthOptions, "config" | "clock"> & { clock?: Clock } = {},
): AttestationTransport {
  try {
    const loaded = loadTransportConfigFromEnv(env);
    if (!loaded.ok) {
      return unconfiguredTransport;
    }
    const [owner = "", repo = ""] = (env.GITHUB_REPOSITORY ?? "").split("/");
    const clock = options.clock ?? { nowMs: () => defaultTimer.now() };
    const tokenProvider = new GitHubAppTokenProvider({ ...options, config: loaded.config, clock });
    return serviceTransport(
      new AttestationServiceClient({
        ...options,
        config: loaded.config,
        tokenProvider,
        owner,
        repo,
      }),
    );
  } catch (error) {
    logger.warn("Attestation configuration invalid; transport disabled.");
    return unconfiguredTransport;
  }
}

/** Verifier and key registry are deliberately untrusted until explicitly supplied. */
export function configuredValidators(
  options: Partial<
    Pick<DecisionContext, "verifier" | "keys" | "expectedBaseSha" | "ciEnvironment">
  > = {},
): TierValidators {
  const context = {
    verifier: { verify: () => ({ verified: false, keyId: "", identity: "" }) },
    keys: { lookup: () => null },
    expectedBaseSha: "",
    ciEnvironment: {},
    ...options,
  };
  return Object.fromEntries(
    ([1, 2, 3] as const).map((tier) => [
      tier,
      {
        async validate(args) {
          const policy = defaultPolicy();
          if (args.attestation.serviceDecision) {
            if (!isServiceDecision(args.attestation.serviceDecision)) {
              return { decision: "ignore", reasons: ["invalid-response"] };
            }
            policy[tier].maxDecision = args.attestation.serviceDecision.kind;
          }
          const result = decideAttestation(
            args.attestation.raw,
            {
              ...context,
              nowMs: args.nowMs,
              recomputedInputHash: args.recomputedInputHash,
              expectedCommitId: args.commitSha,
            },
            policy,
          );
          if (result.tier !== tier || args.attestation.tier !== tier) {
            return { decision: "ignore", reasons: [...result.reasons, "tier-mismatch"] };
          }
          return result;
        },
      } satisfies NonNullable<TierValidators[typeof tier]>,
    ]),
  );
}

const execFileAsync = promisify(execFile);
type Exec = (cmd: string, args: string[]) => Promise<{ stdout: string }>;
/** Reuse the producer's exact lane inputs and hash algorithm over the checked-out commit. */
export function gitTreeInputHasher(exec: Exec = execFileAsync): InputHasher {
  return {
    async recompute(tier, repoRoot) {
      const { stdout } = await exec("git", ["-C", repoRoot, "rev-parse", "HEAD^{tree}"]);
      const treeHash = stdout.trim();
      if (!treeHash) {
        throw new Error("empty git tree hash");
      }
      const probe = new GitTreeProbe(
        "git",
        async (cmd, args) => {
          const result = await exec(cmd, ["-C", repoRoot, ...args]);
          return { code: 0, stdout: result.stdout };
        },
        repoRoot,
      );
      const lane = ({ 1: "node", 2: "android", 3: "ios" } as const)[tier];
      const target = CI_TARGET_PLATFORM[lane];
      // The target job's platform and declared variables, not the gate's own: a gate on a Linux
      // runner hashes for the macOS iOS jobs as those jobs would, and Bun's version is the one the
      // jobs install from the same setup, which the gate shares.
      const input = await new LaneInputHasher(
        { ...target, bunVersion: process.versions.bun ?? null },
        CI_TARGET_ENV[lane],
      ).hash(lane, probe);
      return { treeHash, inputHash: input.hash };
    },
  };
}
export function jsonlFileRecorder(
  path: string,
  appendFile: (path: string, data: string) => Promise<void> = nodeAppendFile,
): ShadowRecorder {
  return {
    async record(entry) {
      await appendFile(path, `${JSON.stringify(entry)}\n`);
    },
  };
}

/** Unknown CI outcomes are excluded, never counted as successful runs. */
export function shadowRecorderBridge(options: {
  jsonl: ShadowRecorder;
  store: { record(observation: ShadowObservation): Promise<unknown> };
  runId: string;
  ciResult: ShadowObservation["ciResult"];
}): ShadowRecorder {
  return {
    async record(entry) {
      // Independent writes preserve JSONL evidence even if the metrics store fails, and vice versa.
      const results = await Promise.allSettled([
        Promise.resolve().then(() => options.jsonl.record(entry)),
        Promise.resolve().then(() =>
          options.store.record({
            tier: entry.tier,
            treeHash: entry.treeHash ?? "",
            runId: options.runId,
            verdict: entry.decision,
            ciResult: options.ciResult,
            hadAttestation: entry.transport === "found",
            ...(entry.decision === "ignore" ? { ignoreReason: entry.reasons.join("; ") } : {}),
          }),
        ),
      ]);
      for (const result of results) {
        if (result.status === "rejected") {
          logger.warn("Attestation shadow recording failed", result.reason);
        }
      }
    },
  };
}
