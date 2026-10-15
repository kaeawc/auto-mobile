import { adaptEnvelope } from "../../../../scripts/ci/attestation/validators/envelopeAdapter";
import { describe, expect, test } from "bun:test";
import {
  decideAttestation,
  defaultPolicy,
  resolvePolicy,
  type IgnoreReason,
} from "../../../../scripts/ci/attestation/validators/trustPolicy";
import { tierValidators } from "../../../../scripts/ci/attestation/validators/tierValidators";
import { fixture, HASH, NOW, type Fixture } from "./helpers";

type FailureCase = {
  name: string;
  reason: IgnoreReason;
  change: (f: Fixture) => void;
  signatureChecked?: boolean;
};
const failures: FailureCase[] = [
  {
    name: "unverified signature",
    reason: "signature-unverified",
    change: (f) => {
      f.verifier.result.verified = false;
    },
  },
  {
    name: "unknown key",
    reason: "key-unknown",
    change: (f) => {
      f.keys.key = null;
    },
  },
  {
    name: "revoked key",
    reason: "key-revoked",
    change: (f) => {
      if (f.keys.key) {
        f.keys.key.revokedAtMs = NOW - 1;
      }
    },
  },
  {
    name: "key not valid yet",
    reason: "key-not-valid-yet",
    change: (f) => {
      if (f.keys.key) {
        f.keys.key.notBeforeMs = NOW + 1;
      }
    },
  },
  {
    name: "expired key",
    reason: "key-expired",
    change: (f) => {
      if (f.keys.key) {
        f.keys.key.notAfterMs = NOW;
      }
    },
  },
  {
    name: "registry identity",
    reason: "identity-mismatch",
    change: (f) => {
      if (f.keys.key) {
        f.keys.key.identity = "other";
      }
    },
  },
  {
    name: "verifier identity",
    reason: "identity-mismatch",
    change: (f) => {
      f.verifier.result.identity = "other";
    },
  },
  {
    name: "verifier key",
    reason: "identity-mismatch",
    change: (f) => {
      f.verifier.result.keyId = "other";
    },
  },
  {
    name: "hash mismatch",
    reason: "hash-mismatch",
    change: (f) => {
      f.envelope.payload.inputHash = "b".repeat(64);
    },
  },
  {
    name: "unavailable recomputed hash",
    reason: "hash-mismatch",
    change: (f) => {
      f.ctx.recomputedInputHash = null;
    },
  },
  {
    name: "malformed hash",
    reason: "malformed-field",
    change: (f) => {
      f.envelope.payload.inputHash = "not-a-hash";
    },
  },
  {
    name: "uppercase hash",
    reason: "malformed-field",
    change: (f) => {
      f.envelope.payload.inputHash = HASH.toUpperCase();
    },
  },
  {
    name: "short hash",
    reason: "malformed-field",
    change: (f) => {
      f.envelope.payload.inputHash = HASH.slice(1);
    },
  },
  {
    name: "malformed recomputed hash",
    signatureChecked: true,
    reason: "malformed-field",
    change: (f) => {
      f.ctx.recomputedInputHash = "z".repeat(64);
    },
  },
  {
    name: "stale attestation",
    reason: "stale-attestation",
    change: (f) => {
      f.envelope.payload.producedAt = new Date(
        NOW - defaultPolicy()[f.envelope.payload.tier].maxAgeMs - 1,
      ).toISOString();
    },
  },
  {
    name: "future attestation",
    reason: "attestation-from-future",
    change: (f) => {
      f.envelope.payload.producedAt = new Date(NOW + 300_001).toISOString();
    },
  },
  {
    name: "stale base",
    reason: "stale-base",
    change: (f) => {
      f.verifier.result.baseSha = "old-base";
    },
  },
  {
    name: "failed result",
    reason: "result-not-success",
    change: (f) => {
      f.envelope.payload.overall = "fail";
      f.envelope.payload.gates[0]!.status = "fail";
    },
  },
  {
    name: "unsupported schema",
    reason: "malformed-field",
    change: (f) => {
      f.envelope.payload.payloadVersion = 2;
    },
  },
];
function assertIgnored(
  f: Fixture,
  raw: unknown,
  reason: IgnoreReason,
  signatureChecked = reason !== "malformed-field",
) {
  const result = decideAttestation(raw, f.ctx, defaultPolicy());
  expect(result.decision).toBe("ignore");
  expect(result.reasons).toEqual(
    signatureChecked ? ["signature-algorithm-unsupported", reason] : [reason],
  );
  const { policy } = resolvePolicy({ [f.envelope.payload.tier]: { ceiling: "skip" } });
  expect(decideAttestation(raw, f.ctx, policy)).toMatchObject({
    decision: "ignore",
    reasons: signatureChecked ? ["signature-algorithm-unsupported", reason] : [reason],
  });
}
function tierFailureTests(tier: 1 | 2 | 3) {
  test.each(failures)("$name", ({ reason, change, signatureChecked }) => {
    const f = fixture(tier);
    change(f);
    assertIgnored(f, f.envelope, reason, signatureChecked);
  });
  test.each(Object.keys(fixture(tier).envelope))("missing %s", (field) => {
    const f = fixture(tier);
    const raw: Record<string, unknown> = { ...f.envelope };
    delete raw[field];
    assertIgnored(f, raw, "malformed-field");
  });
  for (const key of defaultPolicy()[tier].requiredEnvKeys) {
    test.each(["missing", "different", "ci-missing", "ci-different"])(`${key}: %s`, (variant) => {
      const f = fixture(tier);
      const ciEnvironment = { ...f.ctx.ciEnvironment };
      if (variant === "missing") {
        if (key === "os" || key === "arch") {
          Reflect.deleteProperty(f.envelope.payload.environment, key);
        } else if (key === "bun") {
          f.envelope.payload.environment.bunVersion = null;
        } else {
          delete f.envelope.payload.environment.toolVersions[key];
        }
      }
      if (variant === "different") {
        if (key === "os" || key === "arch") {
          f.envelope.payload.environment[key] = "other";
        } else if (key === "bun") {
          f.envelope.payload.environment.bunVersion = "other";
        } else {
          f.envelope.payload.environment.toolVersions[key] = "other";
        }
      }
      if (variant === "ci-missing") {
        delete ciEnvironment[key];
      }
      if (variant === "ci-different") {
        ciEnvironment[key] = "other";
      }
      f.ctx.ciEnvironment = ciEnvironment;
      assertIgnored(
        f,
        f.envelope,
        variant === "missing" && ["os", "arch"].includes(key)
          ? "malformed-field"
          : "environment-mismatch",
      );
    });
  }
  test.each([0, 4, "1", null, 1.5])("unknown tier %j", (unknownTier) => {
    const f = fixture(tier);
    assertIgnored(
      f,
      { ...f.envelope, payload: { ...f.envelope.payload, tier: unknownTier } },
      "malformed-field",
    );
  });
  test.each([null, undefined, [], "envelope", 42, true].map((raw) => ({ raw })))(
    "non-object $raw",
    ({ raw }) => {
      assertIgnored(fixture(tier), raw, "malformed-field");
    },
  );
  test.each(["envelope", "environment"])("__proto__ in %s", (target) => {
    const f = fixture(tier);
    const object = target === "envelope" ? f.envelope : f.envelope.payload.environment.toolVersions;
    Object.defineProperty(object, "__proto__", { value: {}, enumerable: true });
    assertIgnored(f, f.envelope, "malformed-field");
  });
}
for (const tier of [1, 2, 3] as const) {
  describe(`tier ${tier} independent failures`, () => tierFailureTests(tier));
  test(`tier ${tier} unsupported signature blocks default decision`, () => {
    const f = fixture(tier);
    expect(decideAttestation(f.envelope, f.ctx, defaultPolicy())).toMatchObject({
      tier,
      decision: "ignore",
      reasons: ["signature-algorithm-unsupported"],
    });
  });
  test(`tier ${tier} validator rejects unsupported signature`, () => {
    const f = fixture(tier);
    expect(
      tierValidators[tier](
        adaptEnvelope(f.envelope, f.verifier.result),
        f.ctx,
        defaultPolicy()[tier],
      ),
    ).toMatchObject({
      decision: "ignore",
      reasons: ["signature-algorithm-unsupported"],
    });
  });
}

test("tier 2 environment-sensitive task cannot bypass the signature allowlist", () => {
  const f = fixture(2);
  f.verifier.result.task = "connectedAndroidTest";
  const result = decideAttestation(f.envelope, f.ctx, defaultPolicy());
  expect(result.decision).toBe("ignore");
  expect(result.reasons).toEqual(["signature-algorithm-unsupported"]);
});

test.each([
  { task: "connectedDebugAndroidTest" },
  { task: ":app:connectedAndroidTest" },
  { task: "pixel6api34DebugAndroidTest" },
  { task: ":app:CONNECTEDcheck" },
  { task: ":app:managedDeviceCheck" },
  { task: "runEmulatorTests" },
  { task: "runInstrumentedTests" },
  { task: "assembleDebug" },
  { task: ":app:testDebugUnitTest" },
  { task: ":emulator:connected:app:assembleDebug" },
])("tier 2 task $task cannot bypass the signature allowlist", ({ task }) => {
  const f = fixture(2);
  f.verifier.result.task = task;
  expect(decideAttestation(f.envelope, f.ctx, defaultPolicy())).toMatchObject({
    decision: "ignore",
    reasons: ["signature-algorithm-unsupported"],
  });
  expect(
    tierValidators[2](adaptEnvelope(f.envelope, f.verifier.result), f.ctx, defaultPolicy()[2]),
  ).toMatchObject({
    decision: "ignore",
    reasons: ["signature-algorithm-unsupported"],
  });
});

test("direct tier 2 policy rejects empty advisory tokens", () => {
  const f = fixture(2);
  const policy = { ...defaultPolicy()[2], advisoryOnlyTasks: [] };
  expect(
    tierValidators[2](adaptEnvelope(f.envelope, f.verifier.result), f.ctx, policy),
  ).toMatchObject({
    decision: "ignore",
    reasons: ["policy-invalid"],
  });
});

test("direct tier 2 policy inherits omitted advisory tokens", () => {
  const f = fixture(2);
  const policy = defaultPolicy()[2];
  delete policy.advisoryOnlyTasks;
  f.verifier.result.task = ":app:connectedAndroidTest";
  expect(
    tierValidators[2](adaptEnvelope(f.envelope, f.verifier.result), f.ctx, policy),
  ).toMatchObject({
    decision: "ignore",
    reasons: ["signature-algorithm-unsupported"],
  });
});

test.each(["keyId", "identity", "baseSha", "task"])("missing verification claim %s", (field) => {
  const f = fixture();
  Reflect.deleteProperty(f.verifier.result, field);
  const result = decideAttestation(f.envelope, f.ctx, defaultPolicy());
  expect(result.decision).toBe("ignore");
  expect(result.reasons).toContain("missing-field");
});

test.each([
  { field: "payloadVersion", value: "1" },
  { field: "payloadVersion", value: 0 },
  { field: "producedAt", value: NaN },
  { field: "producedAt", value: Infinity },
  { field: "producedAt", value: -1 },
  { field: "producedAt", value: 1.5 },
  { field: "producedAt", value: "not-ISO" },
  { field: "environment", value: [] },
  { field: "environment", value: { os: 1 } },
  { field: "overall", value: true },
])("malformed canonical $field: $value", ({ field, value }) => {
  for (const tier of [1, 2, 3] as const) {
    const f = fixture(tier);
    assertIgnored(
      f,
      { ...f.envelope, payload: { ...f.envelope.payload, [field]: value } },
      "malformed-field",
    );
  }
});

test.each(["keyId", "identity", "baseSha", "task"])("malformed verification claim %s", (field) => {
  for (const value of [null, "", " ", 42]) {
    const f = fixture();
    Reflect.set(f.verifier.result, field, value);
    expect(decideAttestation(f.envelope, f.ctx, defaultPolicy()).decision).toBe("ignore");
  }
});

test.each([1, 2, 3] as const)("direct tier %s validator rejects unverified input", (tier) => {
  const f = fixture(tier);
  f.verifier.result.verified = false;
  const result = tierValidators[tier](
    adaptEnvelope(f.envelope, f.verifier.result),
    f.ctx,
    defaultPolicy()[tier],
  );
  expect(result.decision).toBe("ignore");
  expect(result.reasons).toContain("signature-unverified");
});

test.each([1, 2, 3] as const)("tier %s rejects unknown input hashing algorithms", (tier) => {
  const f = fixture(tier);
  f.envelope.payload.inputHashAlgorithm = "unknown";
  assertIgnored(f, f.envelope, "hash-mismatch");
});

// Exercise both public decision entry points with a verifier that claims success.
test.each([1, 2, 3] as const)("tier %s rejects unknown signature algorithms", (tier) => {
  const f = fixture(tier);
  f.envelope.signature!.algorithm = "unknown";
  expect(f.verifier.result.verified).toBe(true);
  expect(decideAttestation(f.envelope, f.ctx, defaultPolicy())).toMatchObject({
    decision: "ignore",
    reasons: ["signature-algorithm-unsupported"],
  });
  expect(
    tierValidators[tier](
      adaptEnvelope(f.envelope, f.verifier.result),
      f.ctx,
      defaultPolicy()[tier],
    ),
  ).toMatchObject({
    decision: "ignore",
    reasons: ["signature-algorithm-unsupported"],
  });
});
test.each([1, 2, 3] as const)("tier %s null signature remains unverified", (tier) => {
  const f = fixture(tier);
  f.envelope.signature = null;
  expect(f.verifier.result.verified).toBe(true);
  expect(decideAttestation(f.envelope, f.ctx, defaultPolicy())).toMatchObject({
    decision: "ignore",
    reasons: ["signature-unverified"],
  });
  expect(
    tierValidators[tier](
      adaptEnvelope(f.envelope, f.verifier.result),
      f.ctx,
      defaultPolicy()[tier],
    ),
  ).toMatchObject({
    decision: "ignore",
    reasons: ["signature-unverified"],
  });
});
