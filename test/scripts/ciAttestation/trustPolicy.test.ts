import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import {
  decideAttestation,
  defaultPolicy,
  resolvePolicy,
  type PolicyConfig,
} from "../../../scripts/lib/ciAttestation/trustPolicy";
import { fixture, NOW } from "./helpers";

afterEach(() => {
  warn?.mockRestore();
});
let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
function suppressWarnings() {
  warn = spyOn(logger, "warn").mockImplementation(() => {});
}

test("defaults are fresh independent policy objects", () => {
  const first = defaultPolicy();
  expect(first[1].ceiling).toBe("skip");
  expect(first[2].ceiling).toBe("skip");
  expect(first[3].ceiling).toBe("advisory");
  first[1].ceiling = "ignore";
  expect(defaultPolicy()[1].ceiling).toBe("skip");
  expect(resolvePolicy(undefined)).toEqual({ policy: defaultPolicy(), errors: {} });
});

test.each([
  { tier: 1, ceiling: "advisory", decision: "advisory" },
  { tier: 1, ceiling: "ignore", decision: "ignore" },
  { tier: 2, ceiling: "advisory", decision: "advisory" },
  { tier: 3, ceiling: "skip", decision: "skip" },
] as const)("tier $tier ceiling $ceiling", ({ tier, ceiling, decision }) => {
  const f = fixture(tier);
  const { policy, errors } = resolvePolicy({ [tier]: { ceiling } });
  const result = decideAttestation(f.envelope, f.ctx, policy);
  expect(errors).toEqual({});
  expect(result.decision).toBe(decision);
  expect(result.reasons).toEqual(decision === "ignore" ? ["tier-disabled"] : []);
});

test.each(
  [
    null,
    1,
    "skip",
    [],
    { ceiling: undefined },
    { ceiling: "invalid" },
    { maxAgeMs: -1 },
    { maxAgeMs: NaN },
    { requiredEnvKeys: ["__proto__"] },
    { allowedSchemaVersions: [] },
    { allowedSchemaVersions: [1.5] },
    { maxDecision: "invalid" },
    { unknown: true },
  ].map((entry) => ({ entry })),
)("invalid tier config $entry", ({ entry }) => {
  const { policy, errors } = resolvePolicy({ "1": entry });
  const f = fixture();
  expect(errors).toEqual({ "1": ["policy-invalid"] });
  expect(policy[1].ceiling).toBe("ignore");
  expect(policy[2]).toEqual(defaultPolicy()[2]);
  expect(decideAttestation(f.envelope, f.ctx, policy)).toMatchObject({
    decision: "ignore",
    reasons: ["policy-invalid"],
  });
});

test("empty config and empty tier overrides preserve defaults", () => {
  expect(resolvePolicy({})).toEqual(resolvePolicy(undefined));
  expect(resolvePolicy({ "1": {} })).toEqual(resolvePolicy(undefined));
});

test("__proto__ config is fail closed", () => {
  const entry = JSON.parse('{"__proto__":{"ceiling":"skip"}}');
  const { policy, errors } = resolvePolicy({ "3": entry });
  expect(errors[3]).toEqual(["policy-invalid"]);
  expect(policy[3].ceiling).toBe("ignore");
});

test("polluted and unknown top-level policy keys disable all tiers", () => {
  for (const config of [JSON.parse('{"__proto__":{}}'), JSON.parse('{"4":{"ceiling":"skip"}}')]) {
    const { policy, errors } = resolvePolicy(config);
    expect(Object.keys(errors)).toEqual(["1", "2", "3"]);
    expect(Object.values(policy).every((p) => p.ceiling === "ignore")).toBe(true);
  }
});

test.each([1, 2, 3] as const)("tier %s promotion cannot bypass a failing check", (tier) => {
  const f = fixture(tier);
  f.envelope.inputHash = "b".repeat(64);
  const { policy } = resolvePolicy({ [tier]: { ceiling: "skip" } });
  expect(decideAttestation(f.envelope, f.ctx, policy)).toMatchObject({
    decision: "ignore",
    reasons: ["hash-mismatch"],
  });
});

test.each(["ignore", "advisory", "skip"] as const)("external maxDecision cap %s", (maxDecision) => {
  const f = fixture(3);
  const { policy } = resolvePolicy({ "3": { ceiling: "skip", maxDecision } });
  expect(decideAttestation(f.envelope, f.ctx, policy).decision).toBe(maxDecision);
  policy[3].ceiling = "advisory";
  expect(decideAttestation(f.envelope, f.ctx, policy).decision).toBe(
    maxDecision === "ignore" ? "ignore" : "advisory",
  );
});

test("all independent failures are collected without duplicate codes", () => {
  const f = fixture(2);
  f.verifier.result = { verified: false, identity: "wrong", keyId: "wrong" };
  f.envelope.inputHash = "b".repeat(64);
  f.envelope.baseSha = "stale";
  f.envelope.result = "failed";
  f.envelope.schemaVersion = 2;
  f.envelope.producedAtMs = 1;
  f.envelope.environment.jdk = "other";
  if (f.keys.key) {
    f.keys.key.identity = "wrong";
    f.keys.key.revokedAtMs = NOW - 1;
    f.keys.key.notAfterMs = NOW;
  }
  const result = decideAttestation(f.envelope, f.ctx, defaultPolicy());
  expect(result.decision).toBe("ignore");
  expect([...result.reasons].sort()).toEqual(
    [
      "signature-unverified",
      "identity-mismatch",
      "hash-mismatch",
      "stale-base",
      "result-not-success",
      "unsupported-schema-version",
      "stale-attestation",
      "environment-mismatch",
      "key-revoked",
      "key-expired",
    ].sort(),
  );
});

test.each(["verifier", "registry", "hostile-error"])("never throws when %s throws", (seam) => {
  suppressWarnings();
  const f = fixture();
  const failure =
    seam === "hostile-error"
      ? {
          toString: () => {
            throw new Error("stringification failed");
          },
        }
      : new Error("seam failed");
  if (seam === "registry") {
    f.ctx.keys = {
      lookup: () => {
        throw failure;
      },
    };
  } else {
    f.ctx.verifier = {
      verify: () => {
        throw failure;
      },
    };
  }
  const result = decideAttestation(f.envelope, f.ctx, defaultPolicy());
  expect(result.decision).toBe("ignore");
  expect(result.reasons).toEqual(["malformed-field"]);
  expect(result.detail).toContain("evaluation failed");
  expect(warn).toHaveBeenCalledTimes(1);
});

test("verifier receives a frozen envelope snapshot and inputs are not mutated", () => {
  const f = fixture();
  const before = structuredClone(f.envelope);
  const policy = defaultPolicy();
  const beforePolicy = structuredClone(policy);
  decideAttestation(f.envelope, f.ctx, policy);
  expect(f.verifier.raw).not.toBe(f.envelope);
  expect(f.verifier.raw).toEqual(before);
  expect(Object.isFrozen(f.verifier.raw)).toBe(true);
  expect(f.envelope).toEqual(before);
  expect(policy).toEqual(beforePolicy);
});

test.each(["keyId", "identity"])("omitted verifier %s fails closed", (field) => {
  const f = fixture();
  Reflect.deleteProperty(f.verifier.result, field);
  expect(decideAttestation(f.envelope, f.ctx, defaultPolicy())).toMatchObject({
    decision: "ignore",
    reasons: ["signature-unverified"],
  });
});

test.each(["keyId", "identity"])("invalid verifier %s fails closed", (field) => {
  const f = fixture();
  for (const value of [undefined, null, 123, true, {}, [], "", " \t "]) {
    Reflect.set(f.verifier.result, field, value);
    expect(decideAttestation(f.envelope, f.ctx, defaultPolicy())).toMatchObject({
      decision: "ignore",
      reasons: ["signature-unverified"],
    });
  }
});

test.each([null, NOW - 1])(
  "a different signing key cannot borrow envelope trust: %s",
  (revokedAtMs) => {
    const f = fixture();
    const validKey = f.keys.key;
    const signingKey = {
      ...validKey,
      identity: "producer",
      notBeforeMs: 0,
      notAfterMs: null,
      revokedAtMs,
    };
    f.ctx.keys = {
      lookup: (keyId) => (keyId === "signing-key" ? signingKey : validKey),
    };
    f.verifier.result.keyId = "signing-key";
    expect(decideAttestation(f.envelope, f.ctx, defaultPolicy())).toMatchObject({
      decision: "ignore",
      reasons: ["identity-mismatch"],
    });
  },
);

test("a getter-free proxy is copied before validation and verification", () => {
  const f = fixture(2);
  const before = structuredClone(f.envelope);
  const signature = { parts: [{ value: "signed" }] };
  const raw = new Proxy(
    { ...f.envelope, signature },
    {
      get: () => {
        throw new Error("Live envelope properties must not be read");
      },
    },
  );
  f.ctx.keys = {
    lookup: () => {
      f.envelope.environment.jdk = "changed";
      signature.parts[0]!.value = "changed";
      return f.keys.key;
    },
  };
  let received: unknown;
  f.ctx.verifier = {
    verify: (snapshot) => {
      received = snapshot;
      expect(snapshot).not.toBe(raw);
      expect(snapshot).toEqual({ ...before, signature: { parts: [{ value: "signed" }] } });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(Reflect.get(Object(snapshot), "environment"))).toBe(true);
      expect(Object.isFrozen(Reflect.get(Object(snapshot), "signature").parts)).toBe(true);
      expect(Object.isFrozen(Reflect.get(Object(snapshot), "signature").parts[0])).toBe(true);
      return f.verifier.result;
    },
  };
  expect(decideAttestation(raw, f.ctx, defaultPolicy())).toMatchObject({
    decision: "skip",
    reasons: [],
  });
  f.envelope.environment.os = "changed after evaluation";
  expect(received).toEqual({ ...before, signature: { parts: [{ value: "signed" }] } });
});

test("a failed snapshot read is malformed and never reaches the verifier", () => {
  suppressWarnings();
  const f = fixture();
  f.envelope.environment = new Proxy(f.envelope.environment, {
    ownKeys: () => {
      throw new Error("snapshot failed");
    },
  });
  expect(decideAttestation(f.envelope, f.ctx, defaultPolicy())).toMatchObject({
    decision: "ignore",
    reasons: ["malformed-field"],
  });
  expect(f.verifier.raw).toBeUndefined();
});

test.each(
  [[], undefined, null, "connected", [""], [" "], [1], Array(1)].map((value) => ({ value })),
)(
  "explicit invalid tier 2 advisory tokens $value disable only tier 2",
  ({ value: advisoryOnlyTasks }) => {
    const { policy, errors } = resolvePolicy({ "2": { advisoryOnlyTasks } });
    expect(errors).toEqual({ "2": ["policy-invalid"] });
    expect(policy[2].ceiling).toBe("ignore");
    expect(policy[1]).toEqual(defaultPolicy()[1]);
    expect(policy[3]).toEqual(defaultPolicy()[3]);
    const f = fixture(2);
    expect(decideAttestation(f.envelope, f.ctx, policy)).toMatchObject({
      decision: "ignore",
      reasons: ["policy-invalid"],
    });
  },
);

test("omitted tier 2 advisory tokens inherit defaults", () => {
  const { policy, errors } = resolvePolicy({ "2": { maxAgeMs: 1000 } });
  expect(errors).toEqual({});
  expect(policy[2].advisoryOnlyTasks).toEqual([
    "connected",
    "androidtest",
    "manageddevice",
    "emulator",
    "instrumented",
  ]);
  const f = fixture(2);
  f.envelope.task = "connectedDebugAndroidTest";
  expect(decideAttestation(f.envelope, f.ctx, policy).decision).toBe("advisory");
});

test.each(["age", "future", "key-start"])("inclusive allowed boundary: %s", (boundary) => {
  const f = fixture();
  if (boundary === "age") {
    f.envelope.producedAtMs = NOW - defaultPolicy()[1].maxAgeMs;
  }
  if (boundary === "future") {
    f.envelope.producedAtMs = NOW + 300_000;
  }
  if (boundary === "key-start" && f.keys.key) {
    f.keys.key.notBeforeMs = f.envelope.producedAtMs;
  }
  expect(decideAttestation(f.envelope, f.ctx, defaultPolicy()).decision).toBe("skip");
});

test("own-property checking rejects inherited data", () => {
  const f = fixture();
  const raw: unknown = Object.create(f.envelope);
  expect(decideAttestation(raw, f.ctx, defaultPolicy()).reasons).toEqual(["malformed-field"]);
});

test("null-prototype data records are supported", () => {
  const f = fixture();
  const raw = Object.assign(Object.create(null), f.envelope);
  raw.environment = Object.assign(Object.create(null), f.envelope.environment);
  expect(decideAttestation(raw, f.ctx, defaultPolicy()).decision).toBe("skip");
});

test("invalid direct policy input is ignored", () => {
  const f = fixture();
  const policy = defaultPolicy();
  policy[1].maxAgeMs = Infinity;
  expect(decideAttestation(f.envelope, f.ctx, policy).reasons).toEqual(["policy-invalid"]);
});

test("policy schema and environment overrides are validated and applied", () => {
  const config: PolicyConfig = {
    "2": {
      allowedSchemaVersions: [2],
      advisoryOnlyTasks: ["DEVICETEST"],
      requiredEnvKeys: [...defaultPolicy()[2].requiredEnvKeys, "extra"],
      maxAgeMs: 100,
    },
  };
  const { policy, errors } = resolvePolicy(config);
  expect(errors).toEqual({});
  const f = fixture(2);
  f.envelope.schemaVersion = 2;
  f.envelope.producedAtMs = NOW;
  f.envelope.environment.extra = "same";
  f.ctx.ciEnvironment = { ...f.ctx.ciEnvironment, extra: "same" };
  f.envelope.task = ":app:deviceTest";
  expect(decideAttestation(f.envelope, f.ctx, policy).decision).toBe("advisory");
});

test.each([1, 2, 3] as const)("tier %s cannot remove baseline environment checks", (tier) => {
  const { policy, errors } = resolvePolicy({ [tier]: { requiredEnvKeys: [] } });
  expect(errors[tier]).toEqual(["policy-invalid"]);
  const f = fixture(tier);
  expect(decideAttestation(f.envelope, f.ctx, policy).decision).toBe("ignore");
});

test.each(["requiredEnvKeys", "allowedSchemaVersions", "advisoryOnlyTasks"])(
  "sparse %s policy list is invalid",
  (field) => {
    const { errors } = resolvePolicy({ "1": { [field]: Array(1) } });
    expect(errors[1]).toEqual(["policy-invalid"]);
  },
);

test("key must be valid at production as well as evaluation", () => {
  const f = fixture();
  if (f.keys.key) {
    f.keys.key.notBeforeMs = NOW - 500;
  }
  expect(decideAttestation(f.envelope, f.ctx, defaultPolicy()).reasons).toEqual([
    "key-not-valid-yet",
  ]);
});

test("future-dated revocations are conservatively rejected", () => {
  const f = fixture();
  if (f.keys.key) {
    f.keys.key.revokedAtMs = NOW + 1;
  }
  expect(decideAttestation(f.envelope, f.ctx, defaultPolicy()).reasons).toEqual(["key-revoked"]);
});

test("accessors are malformed without evaluating the getter", () => {
  const f = fixture();
  let reads = 0;
  Object.defineProperty(f.envelope, "inputHash", {
    get: () => {
      reads++;
      return "a".repeat(64);
    },
  });
  expect(decideAttestation(f.envelope, f.ctx, defaultPolicy()).reasons).toEqual([
    "malformed-field",
  ]);
  expect(reads).toBe(0);
});

test("a throwing proxy still returns a typed failure", () => {
  suppressWarnings();
  const raw = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error("proxy failed");
      },
    },
  );
  const f = fixture();
  expect(decideAttestation(raw, f.ctx, defaultPolicy())).toMatchObject({
    decision: "ignore",
    reasons: ["malformed-field"],
  });
  expect(warn).toHaveBeenCalledTimes(1);
});

test.each(["identity", "notBeforeMs", "notAfterMs", "revokedAtMs"])(
  "missing registry field %s fails closed",
  (field) => {
    const f = fixture();
    if (f.keys.key) {
      Reflect.deleteProperty(f.keys.key, field);
    }
    expect(decideAttestation(f.envelope, f.ctx, defaultPolicy()).reasons).toEqual([
      "malformed-field",
    ]);
  },
);

test.each([NaN, Infinity, -1, 0.5])("invalid CI clock %s fails closed", (nowMs) => {
  const f = fixture();
  f.ctx.nowMs = nowMs;
  expect(decideAttestation(f.envelope, f.ctx, defaultPolicy()).reasons).toEqual([
    "malformed-field",
  ]);
});

test("invalid CI environment fails closed", () => {
  const f = fixture();
  Object.defineProperty(f.ctx.ciEnvironment, "__proto__", { value: {} });
  expect(decideAttestation(f.envelope, f.ctx, defaultPolicy()).reasons).toEqual([
    "malformed-field",
  ]);
});

test("a cache cap cannot promote the starting iOS policy", () => {
  const f = fixture(3);
  const { policy } = resolvePolicy({ "3": { maxDecision: "skip" } });
  expect(decideAttestation(f.envelope, f.ctx, policy).decision).toBe("advisory");
});

test("non-enumerable config values cannot silently inherit a permissive default", () => {
  const entry = {};
  Object.defineProperty(entry, "ceiling", { value: "invalid" });
  expect(resolvePolicy({ "1": entry }).errors[1]).toEqual(["policy-invalid"]);
});

test.each(["requiredEnvKeys", "allowedSchemaVersions", "advisoryOnlyTasks"])(
  "__proto__ on %s arrays is invalid",
  (field) => {
    const values = field === "allowedSchemaVersions" ? [1] : ["os", "arch", "bun", "nodeMajor"];
    Object.defineProperty(values, "__proto__", { value: {} });
    expect(resolvePolicy({ "1": { [field]: values } }).errors[1]).toEqual(["policy-invalid"]);
  },
);
