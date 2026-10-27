import { arch, platform } from "node:os";
import { tier3InputHash } from "../../../../scripts/ci/attestation/tier23InputHash";
import { beforeEach, afterEach, expect, mock, spyOn, test } from "bun:test";
import { logger } from "../../../../src/utils/logger";
import { FakeFileSystem } from "../../../fakes/FakeFileSystem";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  parseEnvelope,
  type AttestationEnvelope,
} from "../../../../scripts/ci/attestation/attestationSchema";
import {
  configuredTransport,
  configuredValidators,
  gitTreeInputHasher,
  jsonlFileRecorder,
  serviceTransport,
  shadowRecorderBridge,
  unconfiguredTransport,
} from "../../../../scripts/ci/attestation/gate/defaults";
import { runAttestationGate } from "../../../../scripts/ci/attestation/gate/gate";
import type { AttestationRecord, ShadowEntry } from "../../../../scripts/ci/attestation/gate/ports";
import {
  produceAttestations,
  LaneInputHasher,
} from "../../../../scripts/ci/attestation/produceAttestations";
import { ShadowStore } from "../../../../scripts/ci/attestation/shadow/recorder";
import { AttestationServiceClient } from "../../../../scripts/ci/attestation/transport/serviceClient";
import { fixture, HASH, NOW } from "../validators/helpers";
import { FakeTokenProvider, harness, response, validEnv, tokenResponse } from "../transport/fakes";

let warning: ReturnType<typeof spyOn<typeof logger, "warn">>;
afterEach(() => {
  warning.mockRestore();
});
beforeEach(() => {
  warning = spyOn(logger, "warn").mockImplementation(() => {});
});
const query = {
  tier: 1 as const,
  repo: "owner/repo",
  commitSha: "commit",
  treeHash: "tree",
  inputHash: HASH,
};
function validationArgs(envelope: AttestationEnvelope) {
  return {
    attestation: {
      raw: envelope,
      tier: envelope.payload.tier,
      claimedInputHash: envelope.payload.inputHash,
    },
    nowMs: NOW,
    commitSha: "commit",
    recomputedInputHash: HASH,
  };
}
function options(f: ReturnType<typeof fixture>) {
  return {
    verifier: f.verifier,
    keys: f.keys,
    expectedBaseSha: f.ctx.expectedBaseSha,
    ciEnvironment: f.ctx.ciEnvironment,
  };
}

test("transport adapter returns a parsed envelope and service ceiling", async () => {
  const f = fixture();
  const lookup = mock(async () => ({
    decision: { kind: "skip" as const, reason: "verified-match" as const },
    envelope: f.envelope,
  }));
  expect(await serviceTransport({ lookup }).fetch(query)).toEqual({
    kind: "found",
    attestation: {
      raw: f.envelope,
      tier: 1,
      claimedInputHash: HASH,
      serviceDecision: { kind: "skip", reason: "verified-match" },
    },
  });
  expect(lookup).toHaveBeenCalledWith({
    owner: "owner",
    repo: "repo",
    sha: "commit",
    tier: 1,
    inputHash: HASH,
  });
});

test("service client preserves lookup envelope but strips untrusted decision detail", async () => {
  const h = harness();
  h.http.queue.push(
    response({
      kind: "skip",
      reason: "verified-match",
      detail: "secret",
      envelope: fixture().envelope,
    }),
  );
  const client = new AttestationServiceClient({
    ...h,
    owner: "owner",
    repo: "repo",
    tokenProvider: new FakeTokenProvider(),
  });
  const result = await serviceTransport(client).fetch(query);
  expect(result.kind).toBe("found");
  if (result.kind === "found") {
    expect(result.attestation.serviceDecision).toEqual({ kind: "skip", reason: "verified-match" });
  }
  expect(h.http.calls[0]?.url).toEndWith("/v1/decisions");
});

test("transport adapter maps missing evidence to not-found", async () => {
  expect(
    await serviceTransport({
      lookup: async () => ({ decision: { kind: "ignore", reason: "no-attestation" } }),
    }).fetch(query),
  ).toEqual({ kind: "not-found" });
});

test.each(["transport-unavailable", "invalid-response", "unauthenticated"] as const)(
  "transport adapter maps %s to unavailable",
  async (reason) => {
    expect(
      await serviceTransport({
        lookup: async () => ({ decision: { kind: "ignore", reason } }),
      }).fetch(query),
    ).toEqual({ kind: "unavailable", reason });
  },
);

test("transport errors never throw or expose remote error text", async () => {
  const transport = serviceTransport({
    lookup: async () => {
      throw new Error("SECRET");
    },
  });
  expect(await transport.fetch(query)).toEqual({
    kind: "unavailable",
    reason: "transport-unavailable",
  });
  expect(JSON.stringify(warning?.mock.calls)).not.toContain("SECRET");
});

test("a service skip without a canonical envelope cannot become found", async () => {
  expect(
    await serviceTransport({
      lookup: async () => ({
        decision: { kind: "skip", reason: "verified-match" },
        envelope: { verified: true },
      }),
    }).fetch(query),
  ).toEqual({ kind: "unavailable", reason: "invalid-response" });
});

test.each<Record<string, string | undefined>>([
  {},
  { AUTOMOBILE_ATTESTATION_APP_ID: "123" },
  { ...validEnv, AUTOMOBILE_ATTESTATION_SERVICE_URL: "http://unsafe.test" },
])("missing or invalid environment disables transport: %j", async (env) => {
  const transport = configuredTransport(env);
  expect(transport).toBe(unconfiguredTransport);
  expect((await transport.fetch(query)).kind).toBe("unavailable");
});

test("configured environment uses GitHub App and service adapters with injected IO", async () => {
  const h = harness();
  h.http.queue.push(
    tokenResponse(h.clock),
    response({ kind: "skip", reason: "verified-match", envelope: fixture().envelope }),
  );
  const transport = configuredTransport({ ...validEnv, GITHUB_REPOSITORY: "owner/repo" }, h);
  expect(transport).not.toBe(unconfiguredTransport);
  expect((await transport.fetch(query)).kind).toBe("found");
  expect(h.http.calls).toHaveLength(2);
});

test.each([1, 2, 3] as const)(
  "tier %s defaults use real validators but reject unverified signatures",
  async (tier) => {
    const result = await configuredValidators()[tier]!.validate(
      validationArgs(fixture(tier).envelope),
    );
    expect(result.decision).toBe("ignore");
    expect(result.reasons).toContain("signature-unverified");
  },
);

test.each([1, 2, 3] as const)(
  "tier %s verified canonical fixture still requires an approved signature algorithm",
  async (tier) => {
    const f = fixture(tier);
    const result = await configuredValidators(options(f))[tier]!.validate(
      validationArgs(f.envelope),
    );
    expect(result.decision).toBe("ignore");
    expect(result.reasons).toEqual(["signature-algorithm-unsupported"]);
  },
);

test("verified Gradle device task still requires an approved signature algorithm", async () => {
  const f = fixture(2);
  f.verifier.result.task = ":app:connectedDebugAndroidTest";
  expect(
    (await configuredValidators(options(f))[2]!.validate(validationArgs(f.envelope))).decision,
  ).toBe("ignore");
});

test.each(["ignore", "advisory"] as const)(
  "service %s only lowers independently verified eligibility",
  async (kind) => {
    const f = fixture();
    const args = validationArgs(f.envelope);
    const attestation: AttestationRecord = {
      ...args.attestation,
      serviceDecision: { kind, reason: "verified-match" },
    };
    expect(
      (await configuredValidators(options(f))[1]!.validate({ ...args, attestation })).decision,
    ).toBe("ignore");
  },
);

test("CI commit identity is checked independently of verifier claims", async () => {
  const f = fixture();
  f.envelope.payload.commitId = "different";
  expect(
    await configuredValidators(options(f))[1]!.validate(validationArgs(f.envelope)),
  ).toMatchObject({
    decision: "ignore",
    reasons: ["signature-algorithm-unsupported", "commit-mismatch"],
  });
});

test.each(["baseSha", "task"])("missing verifier-bound %s fails closed", async (field) => {
  const f = fixture();
  Reflect.deleteProperty(f.verifier.result, field);
  expect(
    (await configuredValidators(options(f))[1]!.validate(validationArgs(f.envelope))).decision,
  ).toBe("ignore");
});

test("unsigned input stays ignored even if a verifier claims success", async () => {
  const f = fixture();
  f.envelope.signature = null;
  expect(
    (await configuredValidators(options(f))[1]!.validate(validationArgs(f.envelope))).reasons,
  ).toContain("signature-unverified");
});

test.each(["partial", "skipped-gate"])(
  "incomplete producer run %s cannot qualify",
  async (variant) => {
    const f = fixture();
    if (variant === "partial") {
      f.envelope.payload.scope = "partial";
    } else {
      f.envelope.payload.gates[0]!.status = "skip";
    }
    expect(
      await configuredValidators(options(f))[1]!.validate(validationArgs(f.envelope)),
    ).toMatchObject({
      decision: "ignore",
      reasons: ["signature-algorithm-unsupported", "partial-scope"],
    });
  },
);

test("gate hash matches producer's lane entries, not the repository tree ID", async () => {
  const content = "100644 blob 123\tios/a.swift\0";
  const gateHash = await gitTreeInputHasher(async (_cmd, args) => ({
    stdout: args.includes("ls-tree") ? content : "tree\n",
  })).recompute(3, "/repo");
  expect(gateHash).toEqual({
    treeHash: "tree",
    inputHash: tier3InputHash({
      entries: [{ path: "ios/a.swift", id: "123", mode: "100644" }],
      host: { os: platform(), arch: arch() },
      env: process.env,
    }),
  });
});

async function gateEntry(): Promise<ShadowEntry> {
  const entries: ShadowEntry[] = [];
  const timer = new FakeTimer();
  timer.advanceTime(NOW);
  return runAttestationGate({
    transport: unconfiguredTransport,
    hasher: { recompute: async () => ({ treeHash: "tree", inputHash: HASH }) },
    validators: configuredValidators(),
    recorder: {
      record: async (entry) => {
        entries.push(entry);
      },
    },
    clock: { nowMs: () => timer.now() },
    repo: "owner/repo",
    commitSha: "commit",
    repoRoot: "/fake",
    tier: 1,
    mode: "shadow",
  });
}

test("recorder bridge maps observations and retains JSONL using fakes", async () => {
  const entry = await gateEntry();
  entry.transport = "found";
  const fs = new FakeFileSystem();
  const timer = new FakeTimer();
  timer.advanceTime(NOW);
  const append = mock(async (_path: string, _data: string) => {});
  await shadowRecorderBridge({
    jsonl: jsonlFileRecorder("/fake/events.jsonl", append),
    store: new ShadowStore({ fs, timer, dir: "/fake/metrics" }),
    runId: "run-123",
    ciResult: "fail",
  }).record(entry);
  expect(append).toHaveBeenCalledWith("/fake/events.jsonl", `${JSON.stringify(entry)}\n`);
  expect(
    JSON.parse(fs.getWrittenFiles().get("/fake/metrics/shadow-metrics.json") ?? "{}"),
  ).toMatchObject({
    records: [
      {
        tier: 1,
        treeHash: "tree",
        runId: "run-123",
        verdict: "ignore",
        hadAttestation: true,
        ciResult: "fail",
        ignoreReason: entry.reasons.join("; "),
        recordedAtMs: NOW,
      },
    ],
  });
});

test.each(["jsonl", "store"])(
  "%s recorder failure preserves the other write and never escapes the gate",
  async (failure) => {
    const written: string[] = [];
    const recorder = shadowRecorderBridge({
      jsonl: {
        record: async () => {
          if (failure === "jsonl") {
            throw new Error("disk");
          }
          written.push("jsonl");
        },
      },
      store: {
        record: async () => {
          if (failure === "store") {
            throw new Error("disk");
          }
          written.push("store");
        },
      },
      runId: "run",
      ciResult: "cancelled",
    });
    const entry = await runAttestationGate({
      transport: unconfiguredTransport,
      hasher: { recompute: async () => ({ treeHash: "tree", inputHash: HASH }) },
      validators: configuredValidators(),
      recorder,
      clock: { nowMs: () => NOW },
      repo: "owner/repo",
      commitSha: "commit",
      repoRoot: "/fake",
      tier: 1,
      mode: "shadow",
    });
    expect(entry.applied).toBe("run-tier");
    expect(written).toEqual([failure === "jsonl" ? "store" : "jsonl"]);
  },
);

test("produce -> parse -> transport -> validate -> gate -> store remains shadow-only", async () => {
  const f = fixture();
  const envelopes: AttestationEnvelope[] = [];
  const timer = new FakeTimer();
  timer.advanceTime(NOW);
  const probe = {
    headId: async () => "commit",
    dirtyPaths: async () => [],
    inputEntries: async () => [{ path: "src/a.ts", id: "blob", mode: "100644" }],
  };
  const hasher = new LaneInputHasher({ os: "test", arch: "x64", bunVersion: null }, {});
  const produced = await produceAttestations({
    lanes: [
      {
        lane: "node",
        scope: "full",
        gates: [{ name: "build", status: "pass", durationSeconds: 0 }],
      },
    ],
    probe,
    hasher,
    signer: { sign: async () => ({ keyId: "producer-key", algorithm: "fake", value: "fixture" }) },
    sink: {
      publish: async (envelope) => {
        envelopes.push(envelope);
      },
    },
    clock: { nowMs: () => timer.now() },
    environment: f.envelope.payload.environment,
    warn: () => {},
  });
  expect(produced[0]?.outcome).toBe("attested");
  const parsed = parseEnvelope(JSON.parse(JSON.stringify(envelopes[0])));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    throw new Error(parsed.reason);
  }
  const fs = new FakeFileSystem();
  const jsonl: ShadowEntry[] = [];
  const entry = await runAttestationGate({
    transport: serviceTransport({
      lookup: async () => ({
        decision: { kind: "skip", reason: "verified-match" },
        envelope: parsed.envelope,
      }),
    }),
    hasher: {
      recompute: async () => ({
        treeHash: "tree",
        inputHash: (await hasher.hash("node", probe)).hash,
      }),
    },
    validators: configuredValidators(options(f)),
    recorder: shadowRecorderBridge({
      jsonl: {
        record: async (item) => {
          jsonl.push(item);
        },
      },
      store: new ShadowStore({ fs, timer, dir: "/fake/shadow" }),
      runId: "ci-run",
      ciResult: "pass",
    }),
    clock: { nowMs: () => timer.now() },
    repo: "owner/repo",
    commitSha: "commit",
    repoRoot: "/fake",
    tier: 1,
    mode: "shadow",
  });
  expect(entry).toMatchObject({
    decision: "ignore",
    wouldApply: "run-tier",
    applied: "run-tier",
    reasons: ["signature-algorithm-unsupported"],
  });
  expect(jsonl).toEqual([entry]);
  expect(
    JSON.parse(fs.getWrittenFiles().get("/fake/shadow/shadow-metrics.json") ?? "{}"),
  ).toMatchObject({ records: [{ verdict: "ignore", outcome: "false-miss", runId: "ci-run" }] });
});
