import { describe, expect, test } from "bun:test";
import { posix } from "node:path";
import { ShadowStore } from "../../../../scripts/ci/attestation/shadow/recorder";
import { FakeFileSystem } from "../../../fakes/FakeFileSystem";
import { FakeTimer } from "../../../fakes/FakeTimer";

const shadowDir = "/shadow";
// FakeFileSystem keys are normalized to forward slashes, so build expected keys with posix join.
const metricsPath = posix.join(shadowDir, "shadow-metrics.json");

describe("ShadowStore", () => {
  test("writes schema atomically with injected filesystem and clock", async () => {
    const fs = new FakeFileSystem();
    const rename = fs.rename.bind(fs);
    let temporaryContentsAtRename: string | undefined;
    fs.rename = async (oldPath: string, newPath: string) => {
      // Source paths use path.join (backslashes on Windows); read via the fake's normalizing API.
      if (oldPath.replace(/\\/g, "/") === metricsPath + ".tmp") {
        temporaryContentsAtRename = await fs.readFile(oldPath);
      }
      await rename(oldPath, newPath);
    };
    const timer = new FakeTimer();
    timer.setCurrentTime(100);
    const recorder = new ShadowStore({ fs, timer, dir: shadowDir });
    const record = await recorder.record({
      tier: 1,
      treeHash: "hash",
      runId: "run",
      verdict: "skip",
      hadAttestation: false,
      ciResult: "pass",
    });
    const contents = fs.getWrittenFiles().get(metricsPath);
    expect(contents).toBeDefined();
    expect(temporaryContentsAtRename).toBe(contents);
    expect(fs.getWrittenFiles().has(metricsPath + ".tmp")).toBe(false);
    expect(JSON.parse(contents ?? "{}")).toMatchObject({
      schemaVersion: 1,
      records: [record],
      metrics: { generatedAtMs: 100 },
    });
    expect(fs.getWrittenFiles().has(metricsPath + ".tmp")).toBe(false);
  });
  test("fake filesystem reads resolve backslashed paths to normalized keys", async () => {
    const fs = new FakeFileSystem();
    await fs.ensureDir("\\shadow");
    await fs.writeFile("\\shadow\\a.tmp", "data", "utf8");
    expect(await fs.readFile("/shadow/a.tmp")).toBe("data");
    expect(await fs.readFile("\\shadow\\a.tmp")).toBe("data");
    expect(fs.getWrittenFiles().get("\\shadow\\a.tmp")).toBeUndefined();
  });
  test("fake filesystem keys never contain backslashes", async () => {
    const fs = new FakeFileSystem();
    const recorder = new ShadowStore({ fs, timer: new FakeTimer(), dir: shadowDir });
    await recorder.record({
      tier: 1,
      treeHash: "hash",
      runId: "run",
      verdict: "skip",
      hadAttestation: false,
      ciResult: "pass",
    });
    const keys = [...fs.getWrittenFiles().keys()];
    expect(keys).toEqual([metricsPath]);
    expect(keys.some((key) => key.includes("\\"))).toBe(false);
  });
  test("dedupes, caps oldest records, and recovers corrupt data", async () => {
    const fs = new FakeFileSystem();
    const timer = new FakeTimer();
    const recorder = new ShadowStore({ fs, timer, dir: shadowDir, maxRecords: 2 });
    const obs = (runId: string) => ({
      tier: 1 as const,
      treeHash: "h",
      runId,
      verdict: "advisory" as const,
      hadAttestation: false,
      ciResult: "pass" as const,
    });
    await recorder.record(obs("one"));
    timer.advanceTime(1);
    await recorder.record(obs("two"));
    timer.advanceTime(1);
    await recorder.record(obs("one"));
    timer.advanceTime(1);
    await recorder.record(obs("three"));
    const stored: unknown = JSON.parse(fs.getWrittenFiles().get(metricsPath) ?? "{}");
    expect(stored).toMatchObject({ records: [{ runId: "one" }, { runId: "three" }] });
    fs.setFile(metricsPath, "{");
    await recorder.record(obs("recovered"));
    expect(fs.getWrittenFiles().get(metricsPath + ".corrupt-3")).toBe("{");
    expect((await recorder.readMetrics()).tiers[0].runs).toBe(1);
  });
});
