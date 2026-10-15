import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { logger } from "../../../../src/utils/logger";
import {
  runAttestationGate,
  sanitizeAttestationOutput,
} from "../../../../scripts/ci/attestation/gate/gate";
import { resolveCliOptions } from "../../../../scripts/ci/attestation-gate";
import {
  decisionToAction,
  type AttestationVerdict,
  type ShadowEntry,
  type TransportResult,
} from "../../../../scripts/ci/attestation/gate/ports";
import {
  failClosedValidators,
  gitTreeInputHasher,
  jsonlFileRecorder,
  unconfiguredTransport,
} from "../../../../scripts/ci/attestation/gate/defaults";

const now = new Date("2026-10-14T12:00:00Z");
const found: TransportResult = {
  kind: "found",
  attestation: { tier: 1, claimedInputHash: "ci-hash", raw: { opaque: true } },
};
const warn = spyOn(logger, "warn");
beforeAll(() => {
  warn.mockImplementation(() => {});
});
afterAll(() => {
  warn.mockRestore();
});

function fixture(decision: AttestationVerdict = "skip") {
  return {
    transport: { fetch: mock(async (): Promise<TransportResult> => found) },
    hasher: { recompute: mock(async () => ({ treeHash: "tree", inputHash: "ci-hash" })) },
    validators: { 1: { validate: mock(async () => ({ decision, reasons: ["validated"] })) } },
    recorder: { record: mock(async (_entry: ShadowEntry) => {}) },
    clock: { nowMs: () => now.getTime() },
    repo: "owner/repo",
    commitSha: "commit",
    repoRoot: "/fake/repo",
    tier: 1 as const,
    mode: "shadow" as const,
  };
}

for (const [decision, action] of [
  ["skip", "skip-tier"],
  ["advisory", "advisory-tier"],
  ["ignore", "run-tier"],
] as const) {
  test(`matching attestation: ${decision}`, async () => {
    const deps = fixture(decision);
    const entry = await runAttestationGate(deps);
    expect(decisionToAction(decision)).toBe(action);
    expect(entry).toMatchObject({
      decision,
      wouldApply: action,
      applied: "run-tier",
      mode: "shadow",
      schemaVersion: 1,
      recordedAt: now.toISOString(),
      treeHash: "tree",
      recomputedInputHash: "ci-hash",
      claimedInputHash: "ci-hash",
      transport: "found",
      reasons: ["validated"],
    });
    expect(deps.hasher.recompute).toHaveBeenCalledWith(1, "/fake/repo");
    expect(deps.transport.fetch).toHaveBeenCalledWith({
      tier: 1,
      repo: "owner/repo",
      commitSha: "commit",
      treeHash: "tree",
      inputHash: "ci-hash",
    });
    expect(deps.validators[1].validate).toHaveBeenCalledWith({
      attestation: found.kind === "found" ? found.attestation : undefined,
      recomputedInputHash: "ci-hash",
      nowMs: now.getTime(),
      commitSha: "commit",
    });
    expect(deps.recorder.record).toHaveBeenCalledTimes(1);
    expect(deps.recorder.record).toHaveBeenCalledWith(entry);
  });
}

interface FailureCase {
  name: string;
  setup(deps: ReturnType<typeof fixture>): void;
  reason: string;
  transport?: ShadowEntry["transport"];
  noFetch?: boolean;
}
const failures: FailureCase[] = [
  {
    name: "unknown transport kind",
    setup: (d) => {
      // @ts-expect-error Deliberately simulate an untyped transport's unknown result kind.
      d.transport.fetch.mockResolvedValue({ kind: "unexpected" });
    },
    reason: "unknown-transport-result",
    transport: "unavailable",
  },
  {
    name: "lying hash",
    setup: (d) => {
      d.transport.fetch.mockResolvedValue({
        kind: "found",
        attestation: { tier: 1, claimedInputHash: "lie", raw: null },
      });
    },
    reason: "input-hash-mismatch",
    transport: "found",
  },
  {
    name: "not found",
    setup: (d) => {
      d.transport.fetch.mockResolvedValue({ kind: "not-found" });
    },
    reason: "attestation-not-found",
    transport: "not-found",
  },
  {
    name: "unavailable",
    setup: (d) => {
      d.transport.fetch.mockResolvedValue({ kind: "unavailable", reason: "offline" });
    },
    reason: "transport-unavailable: offline",
    transport: "unavailable",
  },
  {
    name: "hash failure",
    setup: (d) => {
      d.hasher.recompute.mockRejectedValue(new Error("hash broke"));
    },
    reason: "hash-recompute-failed: hash broke",
    transport: "skipped",
    noFetch: true,
  },
  {
    name: "transport throws",
    setup: (d) => {
      d.transport.fetch.mockRejectedValue(new Error("offline"));
    },
    reason: "gate-error: offline",
    transport: "skipped",
  },
  {
    name: "tier mismatch",
    setup: (d) => {
      d.transport.fetch.mockResolvedValue({
        kind: "found",
        attestation: { tier: 2, claimedInputHash: "ci-hash", raw: null },
      });
    },
    reason: "tier-mismatch",
    transport: "found",
  },
];
for (const failure of failures) {
  test(`fail closed: ${failure.name}`, async () => {
    const deps = fixture();
    failure.setup(deps);
    const entry = await runAttestationGate(deps);
    expect(entry).toMatchObject({
      decision: "ignore",
      wouldApply: "run-tier",
      applied: "run-tier",
      transport: failure.transport,
      reasons: [failure.reason],
    });
    expect(deps.validators[1].validate).not.toHaveBeenCalled();
    expect(deps.recorder.record).toHaveBeenCalledTimes(1);
    if (failure.noFetch) {
      expect(deps.transport.fetch).not.toHaveBeenCalled();
    }
    if (failure.name === "lying hash") {
      expect(entry.recomputedInputHash).toBe("ci-hash");
    }
  });
}

test("missing validator fails closed", async () => {
  const deps = fixture();
  const entry = await runAttestationGate({ ...deps, validators: {} });
  expect(entry.reasons).toEqual(["no-validator"]);
  expect(entry.applied).toBe("run-tier");
  expect(entry.decision).toBe("ignore");
  expect(deps.recorder.record).toHaveBeenCalledTimes(1);
});
test("validator exception fails closed", async () => {
  const deps = fixture();
  deps.validators[1].validate.mockRejectedValue(new Error("bad envelope"));
  const entry = await runAttestationGate(deps);
  expect(entry).toMatchObject({
    decision: "ignore",
    applied: "run-tier",
    reasons: ["validator-error: bad envelope"],
  });
  expect(deps.recorder.record).toHaveBeenCalledTimes(1);
});
test("recorder exception still resolves", async () => {
  const deps = fixture();
  deps.recorder.record.mockRejectedValue(new Error("disk full"));
  expect((await runAttestationGate(deps)).applied).toBe("run-tier");
  expect(deps.recorder.record).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith("Attestation shadow recorder failed", expect.any(Error));
});
test("unsupported runtime mode is shadow and compile-time mode is restricted", async () => {
  const deps = fixture();
  // @ts-expect-error Deliberately exercise an untyped caller's unsupported mode.
  const entry = await runAttestationGate({ ...deps, mode: "unsupported" });
  expect(entry).toMatchObject({
    mode: "shadow",
    applied: "run-tier",
    decision: "ignore",
    reasons: ["unsupported-mode"],
  });
  expect(deps.transport.fetch).not.toHaveBeenCalled();
  expect(deps.recorder.record).toHaveBeenCalledTimes(1);
});
test("clock failure records once and resolves", async () => {
  const deps = fixture();
  deps.clock.nowMs = () => {
    throw new Error("clock broke");
  };
  const entry = await runAttestationGate(deps);
  expect(entry.decision).toBe("ignore");
  expect(entry.applied).toBe("run-tier");
  expect(deps.recorder.record).toHaveBeenCalledTimes(1);
});
test("defaults fail closed without verifier and transport configuration", async () => {
  expect(
    await unconfiguredTransport.fetch({
      tier: 1,
      repo: "r",
      commitSha: "s",
      treeHash: "t",
      inputHash: "h",
    }),
  ).toEqual({ kind: "unavailable", reason: "attestation transport not configured" });
  expect(Object.keys(failClosedValidators)).toEqual(["1", "2", "3"]);
});
test("git tree adapter uses injected exec and repository root", async () => {
  const exec = mock(async (_cmd: string, args: string[]) => ({
    stdout: args.includes("ls-tree") ? "100644 blob abc\tios/file.swift\0" : "tree-sha\n",
  }));
  expect(await gitTreeInputHasher(exec).recompute(3, "/repo")).toEqual({
    treeHash: "tree-sha",
    inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(exec).toHaveBeenCalledWith("git", ["-C", "/repo", "rev-parse", "HEAD^{tree}"]);
});
test("empty git output fails closed", async () => {
  await expect(
    gitTreeInputHasher(async () => ({ stdout: "\n" })).recompute(1, "/repo"),
  ).rejects.toThrow("empty git tree hash");
});
test("JSONL recorder appends one serialized line through injected IO", async () => {
  const deps = fixture();
  const entry = await runAttestationGate(deps);
  const append = mock(async (_path: string, _data: string) => {});
  await jsonlFileRecorder("/fake/record.jsonl", append).record(entry);
  expect(append).toHaveBeenCalledTimes(1);
  expect(append).toHaveBeenCalledWith("/fake/record.jsonl", `${JSON.stringify(entry)}\n`);
});

test("missing runtime transport fails closed", async () => {
  const deps = fixture();
  // @ts-expect-error Simulate a missing adapter from an untyped caller.
  const entry = await runAttestationGate({ ...deps, transport: undefined });
  expect(entry.decision).toBe("ignore");
  expect(entry.applied).toBe("run-tier");
  expect(deps.validators[1].validate).not.toHaveBeenCalled();
  expect(deps.recorder.record).toHaveBeenCalledTimes(1);
});
test("invalid runtime validator decision fails closed", async () => {
  const deps = fixture();
  // @ts-expect-error Simulate a malformed sibling adapter response.
  deps.validators[1].validate.mockResolvedValue({ decision: "invalid", reasons: [] });
  const entry = await runAttestationGate(deps);
  expect(entry).toMatchObject({
    decision: "ignore",
    reasons: ["invalid-validator-decision"],
    applied: "run-tier",
  });
  expect(deps.recorder.record).toHaveBeenCalledTimes(1);
});
for (const tier of [2, 3] as const) {
  test(`tier ${tier} uses only its registered validator`, async () => {
    const deps = fixture();
    deps.transport.fetch.mockResolvedValue({
      kind: "found",
      attestation: { tier, claimedInputHash: "ci-hash", raw: null },
    });
    const validate = mock(async () => ({
      decision: "advisory" as const,
      reasons: ["tier checked"],
    }));
    const entry = await runAttestationGate({ ...deps, tier, validators: { [tier]: { validate } } });
    expect(entry).toMatchObject({ tier, decision: "advisory", applied: "run-tier" });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(deps.validators[1].validate).not.toHaveBeenCalled();
    expect(deps.recorder.record).toHaveBeenCalledTimes(1);
  });
}

for (const [input, expected] of [
  ["validated", "validated"],
  ["\n::add-mask::x", " : :add-mask: :x"],
  ["a\r\n\t\v\fb", "a b"],
  ["a\u0000\u001b\u007fb", "a b"],
  ["a\u0085\u2028\u2029b", "a b"],
  [":::warning::::x", ": : :warning: : : :x"],
] as const) {
  test(`sanitize workflow output ${JSON.stringify(input)}`, () => {
    expect(sanitizeAttestationOutput(input)).toBe(expected);
  });
}

for (const [env, expected] of [
  [{ ATTESTATION_COMMIT_SHA: "head", GITHUB_SHA: "merge" }, "head"],
  [{ GITHUB_SHA: "merge" }, "merge"],
  [{}, ""],
] as const) {
  test(`CLI commit resolution ${JSON.stringify(env)}`, () => {
    expect(resolveCliOptions([], env).commitSha).toBe(expected);
  });
}

test("CLI resolves arguments and environment without process access", () => {
  const env = { RUNNER_TEMP: "/runner", GITHUB_REPOSITORY: "owner/repo" };
  expect(resolveCliOptions([], env)).toEqual({
    tier: 1,
    record: "/runner/attestation-shadow.jsonl",
    repo: "owner/repo",
    commitSha: "",
  });
  expect(resolveCliOptions(["--tier", "3", "--record", "/custom.jsonl"], env)).toMatchObject({
    tier: 3,
    record: "/custom.jsonl",
  });
});

for (const argv of [["--tier", "0"], ["--tier", "invalid"], ["--unknown"]]) {
  test(`CLI rejects invalid arguments ${argv.join(" ")}`, () => {
    expect(() => resolveCliOptions(argv, {})).toThrow();
  });
}
