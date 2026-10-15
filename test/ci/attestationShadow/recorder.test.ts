import { describe, expect, test } from "bun:test";
import { ShadowRecorder } from "../../../src/ci/attestationShadow/recorder";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("ShadowRecorder", () => {
  test("writes schema atomically with injected filesystem and clock", async () => {
    const fs = new FakeFileSystem();
    const rename = fs.rename.bind(fs);
    let temporaryContentsAtRename: string | undefined;
    fs.rename = async (oldPath: string, newPath: string) => {
      if (oldPath === "/shadow/shadow-metrics.json.tmp") {
        temporaryContentsAtRename = fs.getWrittenFiles().get(oldPath);
      }
      await rename(oldPath, newPath);
    };
    const timer = new FakeTimer();
    timer.setCurrentTime(100);
    const recorder = new ShadowRecorder({ fs, timer, dir: "/shadow" });
    const record = await recorder.record({
      tier: 1,
      treeHash: "hash",
      runId: "run",
      verdict: "skip",
      hadAttestation: false,
      ciResult: "pass",
    });
    const contents = fs.getWrittenFiles().get("/shadow/shadow-metrics.json");
    expect(contents).toBeDefined();
    expect(temporaryContentsAtRename).toBe(contents);
    expect(fs.getWrittenFiles().has("/shadow/shadow-metrics.json.tmp")).toBe(false);
    expect(JSON.parse(contents ?? "{}")).toMatchObject({
      schemaVersion: 1,
      records: [record],
      metrics: { generatedAtMs: 100 },
    });
    expect(fs.getWrittenFiles().has("/shadow/shadow-metrics.json.tmp")).toBe(false);
  });
  test("dedupes, caps oldest records, and recovers corrupt data", async () => {
    const fs = new FakeFileSystem();
    const timer = new FakeTimer();
    const recorder = new ShadowRecorder({ fs, timer, dir: "/shadow", maxRecords: 2 });
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
    const stored: unknown = JSON.parse(
      fs.getWrittenFiles().get("/shadow/shadow-metrics.json") ?? "{}",
    );
    expect(stored).toMatchObject({ records: [{ runId: "one" }, { runId: "three" }] });
    fs.setFile("/shadow/shadow-metrics.json", "{");
    await recorder.record(obs("recovered"));
    expect(fs.getWrittenFiles().get("/shadow/shadow-metrics.json.corrupt-3")).toBe("{");
    expect((await recorder.readMetrics()).tiers[0].runs).toBe(1);
  });
});
