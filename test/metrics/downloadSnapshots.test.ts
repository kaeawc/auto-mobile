import { expect, describe, test } from "bun:test";
import {
  buildSnapshot,
  computeAssetDailyDeltas,
  mergeSnapshot,
  parseSnapshots,
  serializeSnapshots,
  utcDateString,
  type DownloadSnapshot,
  type DownloadSources,
  type GithubAssetCount,
  type NpmDayCount,
} from "../../src/metrics/downloadSnapshots";
import { collect } from "../../scripts/metrics/collect-release-downloads";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** In-memory fake sources — tests never hit the network. */
function fakeSources(github: GithubAssetCount[], npm: NpmDayCount[]): DownloadSources {
  return {
    fetchGithubAssetCounts: async () => github,
    fetchNpmDailyCounts: async () => npm,
  };
}

describe("downloadSnapshots pure logic", () => {
  test("utcDateString extracts the UTC calendar date", () => {
    expect(utcDateString(new Date("2026-07-31T23:59:59.000Z"))).toBe("2026-07-31");
    // A time just before UTC midnight in a negative offset is still that UTC day.
    expect(utcDateString(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01");
  });

  test("mergeSnapshot appends a new date and keeps ascending order", () => {
    const day1 = buildSnapshot("2026-07-29", [], []);
    const day2 = buildSnapshot("2026-07-30", [], []);
    const merged = mergeSnapshot([day2], day1);
    expect(merged.map(s => s.date)).toEqual(["2026-07-29", "2026-07-30"]);
  });

  test("mergeSnapshot is idempotent — same UTC date overwrites, never duplicates", () => {
    const existing: DownloadSnapshot[] = [
      buildSnapshot("2026-07-30", [{ tag: "v0.0.1", asset: "a.apk", cumulative: 10 }], []),
    ];
    const rerun = buildSnapshot(
      "2026-07-30",
      [{ tag: "v0.0.1", asset: "a.apk", cumulative: 12 }],
      [{ day: "2026-07-29", downloads: 5 }]
    );
    const merged = mergeSnapshot(existing, rerun);
    expect(merged).toHaveLength(1);
    expect(merged[0].github[0].cumulative).toBe(12);
    expect(merged[0].npm).toHaveLength(1);
  });

  test("serialize/parse round-trips and produces one line per snapshot", () => {
    const snapshots = [
      buildSnapshot("2026-07-29", [{ tag: "v1", asset: "a.apk", cumulative: 1 }], []),
      buildSnapshot("2026-07-30", [{ tag: "v1", asset: "a.apk", cumulative: 3 }], []),
    ];
    const jsonl = serializeSnapshots(snapshots);
    expect(jsonl.trimEnd().split("\n")).toHaveLength(2);
    expect(parseSnapshots(jsonl)).toEqual(snapshots);
  });

  test("parseSnapshots skips blank lines and trailing newline", () => {
    const jsonl = '{"date":"2026-07-30","github":[],"npm":[]}\n\n';
    expect(parseSnapshots(jsonl)).toHaveLength(1);
  });

  test("computeAssetDailyDeltas: first appearance is day-0 seed (null)", () => {
    const snapshots = [
      buildSnapshot("2026-07-30", [{ tag: "v1", asset: "a.apk", cumulative: 100 }], []),
    ];
    const deltas = computeAssetDailyDeltas(snapshots);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta).toBeNull();
    expect(deltas[0].cumulative).toBe(100);
  });

  test("computeAssetDailyDeltas: correct daily delta across two snapshots", () => {
    const snapshots = [
      buildSnapshot("2026-07-29", [{ tag: "v1", asset: "a.apk", cumulative: 100 }], []),
      buildSnapshot("2026-07-30", [{ tag: "v1", asset: "a.apk", cumulative: 137 }], []),
    ];
    const deltas = computeAssetDailyDeltas(snapshots);
    const day2 = deltas.find(d => d.date === "2026-07-30");
    expect(day2?.delta).toBe(37);
  });

  test("computeAssetDailyDeltas: cumulative reset clamps to 0, not negative", () => {
    const snapshots = [
      buildSnapshot("2026-07-29", [{ tag: "v1", asset: "a.apk", cumulative: 100 }], []),
      buildSnapshot("2026-07-30", [{ tag: "v1", asset: "a.apk", cumulative: 40 }], []),
    ];
    const day2 = computeAssetDailyDeltas(snapshots).find(d => d.date === "2026-07-30");
    expect(day2?.delta).toBe(0);
  });

  test("computeAssetDailyDeltas: missing asset in later snapshot produces no row, does not carry forward", () => {
    const snapshots = [
      buildSnapshot("2026-07-29", [
        { tag: "v1", asset: "a.apk", cumulative: 10 },
        { tag: "v1", asset: "b.ipa", cumulative: 5 },
      ], []),
      // b.ipa absent on day 2.
      buildSnapshot("2026-07-30", [{ tag: "v1", asset: "a.apk", cumulative: 12 }], []),
    ];
    const deltas = computeAssetDailyDeltas(snapshots);
    const day2 = deltas.filter(d => d.date === "2026-07-30");
    expect(day2).toHaveLength(1);
    expect(day2[0].asset).toBe("a.apk");
    expect(day2[0].delta).toBe(2);
  });

  test("computeAssetDailyDeltas: asset reappearing after a gap diffs against its last seen value", () => {
    const snapshots = [
      buildSnapshot("2026-07-28", [{ tag: "v1", asset: "b.ipa", cumulative: 5 }], []),
      buildSnapshot("2026-07-29", [{ tag: "v1", asset: "a.apk", cumulative: 1 }], []),
      buildSnapshot("2026-07-30", [{ tag: "v1", asset: "b.ipa", cumulative: 9 }], []),
    ];
    const reappear = computeAssetDailyDeltas(snapshots).find(
      d => d.date === "2026-07-30" && d.asset === "b.ipa"
    );
    expect(reappear?.delta).toBe(4);
  });
});

describe("collect() CLI wiring with fakes", () => {
  test("writes today's snapshot and is idempotent on re-run (no duplicate date)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "dl-metrics-"));
    const dataFile = path.join(dir, "downloads.jsonl");
    const now = new Date("2026-07-31T06:00:00.000Z");

    try {
      const sources1 = fakeSources(
        [{ tag: "v0.0.45", asset: "control-proxy.apk", cumulative: 10 }],
        [{ day: "2026-07-30", downloads: 500 }]
      );
      const first = await collect(sources1, dataFile, now);
      expect(first.date).toBe("2026-07-31");

      // Re-run same UTC date with a higher cumulative — must overwrite, not append.
      const sources2 = fakeSources(
        [{ tag: "v0.0.45", asset: "control-proxy.apk", cumulative: 14 }],
        [{ day: "2026-07-30", downloads: 500 }]
      );
      await collect(sources2, dataFile, now);

      const snapshots = parseSnapshots(await readFile(dataFile, "utf8"));
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].date).toBe("2026-07-31");
      expect(snapshots[0].github[0].cumulative).toBe(14);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
