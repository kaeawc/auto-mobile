import { expect, test } from "bun:test";
import { CliDeps, runCli } from "../../scripts/ci/produce-attestations";
import { ProduceOptions } from "../../scripts/ci/attestation/produceAttestations";

function fixture(dirty = false) {
  const logs: string[] = [];
  const warnings: string[] = [];
  const published: string[] = [];
  const options: Omit<ProduceOptions, "lanes"> = {
    probe: {
      async headId() {
        return "head";
      },
      async dirtyPaths() {
        return dirty ? ["src/a.ts"] : [];
      },
      async inputEntries() {
        return [{ path: "src/a.ts", mode: "100644", id: "id" }];
      },
    },
    hasher: {
      async hash() {
        return { hash: "a".repeat(64), algorithm: "fake" };
      },
    },
    signer: {
      async sign() {
        return null;
      },
    },
    sink: {
      async publish(env) {
        published.push(env.payload.scope);
      },
    },
    clock: { nowIso: () => "2026-01-01T00:00:00.000Z" },
    environment: { os: "fake", arch: "fake", bunVersion: null, toolVersions: {} },
    warn: (message) => warnings.push(message),
  };
  const deps: CliDeps = {
    log: (message) => logs.push(message),
    warn: options.warn,
    async createOptions() {
      return options;
    },
  };
  return { logs, warnings, published, options, deps };
}
test("CLI usage errors exit 2 without creating dependencies", async () => {
  const f = fixture();
  let called = false;
  f.deps.createOptions = async () => {
    called = true;
    return f.options;
  };
  for (const args of [
    [],
    ["--lane", "unknown"],
    ["--lane", "node"],
    ["--lane", "node", "--scope", "unknown", "--gate", "lint=pass:0"],
  ]) {
    expect(await runCli(args, {}, f.deps)).toBe(2);
  }
  expect(called).toBe(false);
});
test("CLI disable exits 0 before validation or dependency creation", async () => {
  const f = fixture();
  f.deps.createOptions = async () => {
    throw new Error("should not run");
  };
  expect(await runCli([], { AUTOMOBILE_ATTESTATIONS: "0" }, f.deps)).toBe(0);
  expect(f.logs).toEqual(["attestations disabled"]);
});
test("CLI dirty skip exits 0", async () => {
  const f = fixture(true);
  expect(await runCli(["--lane", "node", "--gate", "lint=pass:0"], {}, f.deps)).toBe(0);
  expect(f.logs[0]).toContain("skipped-dirty");
  expect(f.published).toEqual([]);
});
test("CLI dependency errors exit 0 and warn", async () => {
  const f = fixture();
  f.deps.createOptions = async () => {
    throw new Error("unavailable");
  };
  expect(await runCli(["--lane", "node", "--gate", "lint=pass:0"], {}, f.deps)).toBe(0);
  expect(f.warnings[0]).toContain("unavailable");
});
test("CLI defaults partial and forwards explicit scope and start state", async () => {
  const f = fixture();
  const args = ["--lane", "node", "--gate", "lint=PASS:0"];
  expect(await runCli(args, {}, f.deps)).toBe(0);
  expect(
    await runCli(
      [...args, "--scope", "full", "--scope-note", "all", "--expected-head", "head"],
      {},
      f.deps,
    ),
  ).toBe(0);
  expect(f.published).toEqual(["partial", "full"]);
  await runCli([...args, "--started-dirty"], {}, f.deps);
  expect(f.logs[2]).toContain("skipped-dirty");
  await runCli([...args, "--expected-head", "old"], {}, f.deps);
  expect(f.logs[3]).toContain("HEAD moved during run");
});
test("CLI initial dirty mode shares the lane path list", async () => {
  const f = fixture(true);
  expect(await runCli(["--lane", "ios", "--print-dirty-at-start"], {}, f.deps)).toBe(0);
  expect(f.logs).toEqual(["dirty"]);
  expect(f.published).toEqual([]);
});
