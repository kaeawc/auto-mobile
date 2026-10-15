import { describe, expect, test } from "bun:test";
import {
  AttestationEnvelope,
  AttestationLane,
  GateResult,
} from "../../scripts/ci/attestation/attestationSchema";
import {
  CompositeSink,
  TreeEntriesInputHasher,
  FileSystem,
  InputHasher,
  LocalFileSink,
  TreeProbe,
  produceAttestations,
} from "../../scripts/ci/attestation/produceAttestations";

class FakeTreeProbe implements TreeProbe {
  constructor(
    public dirty: string[] = [],
    public entries = [{ path: "a", mode: "100644", id: "1" }],
  ) {}
  async headId() {
    return "tree-id";
  }
  async dirtyPaths() {
    return this.dirty;
  }
  async inputEntries() {
    return this.entries;
  }
}
const hasher: InputHasher = {
  async hash() {
    return { hash: "b".repeat(64), algorithm: "fake" };
  },
};
const gate: GateResult = { name: "lint", status: "pass", durationSeconds: 0 };
const environment = { os: "test", arch: "x64", bunVersion: null, toolVersions: {} };
const options = (
  lane: AttestationLane,
  probe = new FakeTreeProbe(),
  overrides: Partial<{
    signer: { sign(value: string): Promise<null> };
    sink: { publish(env: AttestationEnvelope, id: string): Promise<void> };
    warn: (message: string) => void;
  }> = {},
) => {
  const published: AttestationEnvelope[] = [];
  const warnings: string[] = [];
  return {
    published,
    warnings,
    opts: {
      lanes: [{ lane, gates: [gate] }],
      probe,
      hasher,
      signer: overrides.signer ?? {
        async sign() {
          return null;
        },
      },
      sink: overrides.sink ?? {
        async publish(env: AttestationEnvelope) {
          published.push(env);
        },
      },
      clock: { nowIso: () => "2026-01-01T00:00:00.000Z" },
      environment,
      warn: overrides.warn ?? ((message: string) => warnings.push(message)),
    },
  };
};
describe("produce attestations", () => {
  test("records clean results with lane tier and timestamp", async () => {
    for (const [lane, tier] of [
      ["node", 1],
      ["android", 2],
      ["ios", 3],
    ] as const) {
      const fixture = options(lane);
      const result = await produceAttestations(fixture.opts);
      expect(result[0]?.outcome).toBe("attested");
      expect(fixture.published[0]?.payload.tier).toBe(tier);
      expect(fixture.published[0]?.payload.producedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(fixture.published[0]?.payload.inputHash).toBe("b".repeat(64));
      expect(fixture.published[0]?.payload.gates).toEqual([gate]);
      expect(fixture.published[0]?.payload.overall).toBe("pass");
    }
  });
  test("skips dirty inputs without publishing", async () => {
    const fixture = options("node", new FakeTreeProbe(["src/a.ts"]));
    expect((await produceAttestations(fixture.opts))[0]?.outcome).toBe("skipped-dirty");
    expect(fixture.published).toHaveLength(0);
  });
  test("records failing gates as a failed attestation", async () => {
    const fixture = options("android");
    fixture.opts.lanes[0]!.gates = [{ ...gate, status: "fail" }];
    expect((await produceAttestations(fixture.opts))[0]?.outcome).toBe("attested");
    expect(fixture.published[0]?.payload.overall).toBe("fail");
  });
  test("returns typed errors for signer and sink failures", async () => {
    const signerFixture = options("ios", undefined, {
      signer: {
        async sign() {
          throw new Error("sign failed");
        },
      },
    });
    expect((await produceAttestations(signerFixture.opts))[0]?.outcome).toBe("skipped-error");
    const sinkFixture = options("node", undefined, {
      sink: {
        async publish() {
          throw new Error("sink failed");
        },
      },
    });
    expect((await produceAttestations(sinkFixture.opts))[0]?.outcome).toBe("skipped-error");
    expect(sinkFixture.warnings[0]).toContain("sink failed");
  });
  test("hash is stable across ordering and changes with IDs", async () => {
    const { TreeEntriesInputHasher } =
      await import("../../scripts/ci/attestation/produceAttestations");
    const h = new TreeEntriesInputHasher();
    const first = new FakeTreeProbe(
      [],
      [
        { path: "b", mode: "100644", id: "2" },
        { path: "a", mode: "100644", id: "1" },
      ],
    );
    const second = new FakeTreeProbe(
      [],
      [
        { path: "a", mode: "100644", id: "1" },
        { path: "b", mode: "100644", id: "2" },
      ],
    );
    expect(await h.hash("node", first)).toEqual(await h.hash("node", second));
    second.entries[0] = { path: "a", mode: "100644", id: "3" };
    expect(await h.hash("node", first)).not.toEqual(await h.hash("node", second));
  });
  test("local file sink writes lane and ID with JSON content", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const fs: FileSystem = {
      async mkdir() {},
      async writeFile(path, content) {
        writes.push({ path, content });
      },
    };
    const fixture = options("node");
    await produceAttestations(fixture.opts);
    const recorded = fixture.published[0];
    if (!recorded) {
      throw new Error("expected published envelope");
    }
    await new LocalFileSink("/attestations", fs).publish(recorded, "id-1");
    expect(writes[0]?.path).toBe("/attestations/node-id-1.json");
    expect(writes[0]?.content.endsWith("\n")).toBe(true);
    expect(JSON.parse(writes[0]?.content ?? "{}").payload.lane).toBe("node");
  });
});

test("HEAD changes and initial dirtiness prevent publishing", async () => {
  const fixture = options("node");
  expect(
    (
      await produceAttestations({
        ...fixture.opts,
        lanes: [{ lane: "node", gates: [gate], expectedHead: "old-head" }],
      })
    )[0]?.detail,
  ).toContain("HEAD moved during run");
  expect(
    (
      await produceAttestations({
        ...fixture.opts,
        lanes: [{ lane: "node", gates: [gate], startedDirty: true }],
      })
    )[0]?.outcome,
  ).toBe("skipped-dirty");
  expect(fixture.published).toHaveLength(0);
});
test("HEAD moving while hashing is detected even without expectedHead", async () => {
  const fixture = options("node");
  let head = "before";
  fixture.opts.probe.headId = async () => head;
  fixture.opts.hasher = {
    async hash() {
      head = "after";
      return { hash: "a".repeat(64), algorithm: "fake" };
    },
  };
  expect((await produceAttestations(fixture.opts))[0]?.detail).toContain("HEAD moved during run");
  expect(fixture.published).toHaveLength(0);
});
test("empty entries become skipped-error", async () => {
  const fixture = options("ios", new FakeTreeProbe([], []));
  expect(
    (await produceAttestations({ ...fixture.opts, hasher: new TreeEntriesInputHasher() }))[0]
      ?.detail,
  ).toContain("empty input entries");
  expect(fixture.published).toHaveLength(0);
});
test("composite tries every sink and reports every failure", async () => {
  const fixture = options("node");
  const calls: string[] = [];
  const sink = new CompositeSink(
    [
      {
        async publish() {
          calls.push("first");
          throw new Error("first failure");
        },
      },
      {
        async publish() {
          calls.push("second");
        },
      },
      {
        async publish() {
          calls.push("third");
          throw new Error("third failure");
        },
      },
    ],
    fixture.opts.warn,
  );
  const result = await produceAttestations({ ...fixture.opts, sink });
  expect(calls).toEqual(["first", "second", "third"]);
  expect(result[0]?.outcome).toBe("skipped-error");
  expect(result[0]?.detail).toContain("first failure; Error: third failure");
  expect(fixture.warnings).toHaveLength(3);
});
test("hash orders paths by code units, includes modes, and preserves probe entries", async () => {
  const probe = new FakeTreeProbe(
    [],
    ["a", "Z", "A", "!"].map((path) => ({ path, id: "id", mode: "100644" })),
  );
  const before = [...probe.entries];
  const hash = await new TreeEntriesInputHasher().hash("node", probe);
  const { createHash } = await import("node:crypto");
  const content = ["!", "A", "Z", "a"]
    .map((path) => `${JSON.stringify([path, "id", "100644"])}\n`)
    .join("");
  expect(hash.hash).toBe(createHash("sha256").update(content).digest("hex"));
  expect(probe.entries).toEqual(before);
  probe.entries[0]!.mode = "100755";
  expect(await new TreeEntriesInputHasher().hash("node", probe)).not.toEqual(hash);
});
test("tabs and newlines cannot collide in the entry encoding", async () => {
  const h = new TreeEntriesInputHasher();
  const a = new FakeTreeProbe([], [{ path: "a\tb\nc", id: "d", mode: "100644" }]);
  const b = new FakeTreeProbe([], [{ path: "a", id: "b\nc\td", mode: "100644" }]);
  expect(await h.hash("node", a)).not.toEqual(await h.hash("node", b));
});
test("scope metadata defaults partial and preserves explicit full", async () => {
  const fixture = options("node");
  await produceAttestations(fixture.opts);
  expect(fixture.published[0]?.payload.scope).toBe("partial");
  await produceAttestations({
    ...fixture.opts,
    lanes: [{ lane: "node", gates: [gate], scope: "full", scopeNote: "all gates" }],
  });
  expect(fixture.published[1]?.payload.scope).toBe("full");
  expect(fixture.published[1]?.payload.scopeNote).toBe("all gates");
});
