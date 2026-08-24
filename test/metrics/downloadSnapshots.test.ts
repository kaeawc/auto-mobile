import { expect, describe, test } from "bun:test";
import {
  buildSnapshot,
  classifyAssetType,
  compareTagsDesc,
  computeAssetDailyDeltas,
  excludeIncompleteNpmDay,
  mergeSnapshot,
  parseSnapshots,
  rollingAverage,
  serializeSnapshots,
  summarizeCumulativeByTag,
  summarizeDailyByAssetType,
  utcDateString,
  utcDayDifference,
  type DownloadSnapshot,
  type DownloadSources,
  type FileStore,
  type GithubAssetCount,
  type NpmDayCount,
} from "../../src/metrics/downloadSnapshots";
import { collect } from "../../scripts/metrics/collect-release-downloads";

/**
 * In-memory {@link FileStore} fake — no real temp dirs. `readFile` rejects with
 * a `{ code: "ENOENT" }` error when the path is absent, matching the CLI's
 * `node:fs/promises`-backed store, so collect()'s ENOENT handling is exercised.
 */
function fakeFiles(seed?: Record<string, string>): FileStore & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    store,
    readFile: async (filePath: string) => {
      const contents = store.get(filePath);
      if (contents === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file ${filePath}`), { code: "ENOENT" });
      }
      return contents;
    },
    mkdir: async () => {},
    writeFile: async (filePath: string, data: string) => {
      store.set(filePath, data);
    },
  };
}

/**
 * The synthetic three-day sample that previously shipped in
 * docs/metrics/data/downloads.jsonl. It was moved here so the committed
 * production data file can start empty (it must never carry fabricated rows —
 * mergeSnapshot only overwrites the incoming date, so seeded rows persist
 * forever). The dashboard/tests can still exercise realistic multi-day data
 * from this fixture.
 */
const SAMPLE_SNAPSHOTS_JSONL =
  [
    '{"date":"2026-07-29","github":[{"tag":"0.0.47","asset":"control-proxy-debug.apk","cumulative":150},{"tag":"0.0.47","asset":"control-proxy.ipa","cumulative":90},{"tag":"0.0.47","asset":"automobile-video.jar","cumulative":2},{"tag":"0.0.47","asset":"AutoMobile-0.0.47-macos.dmg","cumulative":1},{"tag":"0.0.46","asset":"control-proxy-debug.apk","cumulative":400},{"tag":"0.0.46","asset":"control-proxy.ipa","cumulative":330},{"tag":"0.0.45","asset":"control-proxy-debug.apk","cumulative":6050},{"tag":"0.0.45","asset":"control-proxy.ipa","cumulative":600}],"npm":[{"day":"2026-07-27","downloads":822},{"day":"2026-07-28","downloads":474},{"day":"2026-07-29","downloads":652}]}',
    '{"date":"2026-07-30","github":[{"tag":"0.0.47","asset":"control-proxy-debug.apk","cumulative":180},{"tag":"0.0.47","asset":"control-proxy.ipa","cumulative":104},{"tag":"0.0.47","asset":"automobile-video.jar","cumulative":3},{"tag":"0.0.47","asset":"AutoMobile-0.0.47-macos.dmg","cumulative":2},{"tag":"0.0.46","asset":"control-proxy-debug.apk","cumulative":405},{"tag":"0.0.46","asset":"control-proxy.ipa","cumulative":334},{"tag":"0.0.45","asset":"control-proxy-debug.apk","cumulative":6088},{"tag":"0.0.45","asset":"control-proxy.ipa","cumulative":610}],"npm":[{"day":"2026-07-28","downloads":474},{"day":"2026-07-29","downloads":652},{"day":"2026-07-30","downloads":1013}]}',
    '{"date":"2026-07-31","github":[{"tag":"0.0.47","asset":"control-proxy-debug.apk","cumulative":209},{"tag":"0.0.47","asset":"control-proxy.ipa","cumulative":119},{"tag":"0.0.47","asset":"automobile-video.jar","cumulative":3},{"tag":"0.0.47","asset":"AutoMobile-0.0.47-macos.dmg","cumulative":3},{"tag":"0.0.46","asset":"control-proxy-debug.apk","cumulative":410},{"tag":"0.0.46","asset":"control-proxy.ipa","cumulative":339},{"tag":"0.0.45","asset":"control-proxy-debug.apk","cumulative":6112},{"tag":"0.0.45","asset":"control-proxy.ipa","cumulative":620}],"npm":[{"day":"2026-07-29","downloads":652},{"day":"2026-07-30","downloads":1013},{"day":"2026-07-31","downloads":774}]}',
  ].join("\n") + "\n";

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
    expect(merged.map((s) => s.date)).toEqual(["2026-07-29", "2026-07-30"]);
  });

  test("mergeSnapshot is idempotent — same UTC date overwrites, never duplicates", () => {
    const existing: DownloadSnapshot[] = [
      buildSnapshot("2026-07-30", [{ tag: "v0.0.1", asset: "a.apk", cumulative: 10 }], []),
    ];
    const rerun = buildSnapshot(
      "2026-07-30",
      [{ tag: "v0.0.1", asset: "a.apk", cumulative: 12 }],
      [{ day: "2026-07-29", downloads: 5 }],
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
    const day2 = deltas.find((d) => d.date === "2026-07-30");
    expect(day2?.delta).toBe(37);
  });

  test("computeAssetDailyDeltas: cumulative reset yields null (unknown), not a false 0", () => {
    const snapshots = [
      buildSnapshot("2026-07-29", [{ tag: "v1", asset: "a.apk", cumulative: 100 }], []),
      buildSnapshot("2026-07-30", [{ tag: "v1", asset: "a.apk", cumulative: 40 }], []),
    ];
    const day2 = computeAssetDailyDeltas(snapshots).find((d) => d.date === "2026-07-30");
    expect(day2?.delta).toBeNull();
  });

  test("computeAssetDailyDeltas: changed asset id yields null even when cumulative did not decrease", () => {
    // Same tag+filename on consecutive days, but the asset was deleted and
    // re-uploaded, so it carries a NEW GitHub id (111 -> 222). The counter reset
    // to a fresh 8; a naive tag+name diff would fabricate a delta of 3 (8 - 5).
    const snapshots = [
      buildSnapshot("2026-07-29", [{ tag: "v1", asset: "a.apk", cumulative: 5, id: 111 }], []),
      buildSnapshot("2026-07-30", [{ tag: "v1", asset: "a.apk", cumulative: 8, id: 222 }], []),
    ];
    const day2 = computeAssetDailyDeltas(snapshots).find((d) => d.date === "2026-07-30");
    expect(day2?.delta).toBeNull(); // not 3 — identity changed
    expect(day2?.cumulative).toBe(8);
  });

  test("computeAssetDailyDeltas: stable asset id with a normal increase still yields a numeric delta", () => {
    const snapshots = [
      buildSnapshot("2026-07-29", [{ tag: "v1", asset: "a.apk", cumulative: 5, id: 111 }], []),
      buildSnapshot("2026-07-30", [{ tag: "v1", asset: "a.apk", cumulative: 8, id: 111 }], []),
    ];
    const day2 = computeAssetDailyDeltas(snapshots).find((d) => d.date === "2026-07-30");
    expect(day2?.delta).toBe(3); // same id, honest daily delta
  });

  test("computeAssetDailyDeltas: missing asset in later snapshot produces no row, does not carry forward", () => {
    const snapshots = [
      buildSnapshot(
        "2026-07-29",
        [
          { tag: "v1", asset: "a.apk", cumulative: 10 },
          { tag: "v1", asset: "b.ipa", cumulative: 5 },
        ],
        [],
      ),
      // b.ipa absent on day 2.
      buildSnapshot("2026-07-30", [{ tag: "v1", asset: "a.apk", cumulative: 12 }], []),
    ];
    const deltas = computeAssetDailyDeltas(snapshots);
    const day2 = deltas.filter((d) => d.date === "2026-07-30");
    expect(day2).toHaveLength(1);
    expect(day2[0].asset).toBe("a.apk");
    expect(day2[0].delta).toBe(2);
  });

  test("computeAssetDailyDeltas: asset reappearing after a gap yields null (multi-day increase unknowable)", () => {
    const snapshots = [
      buildSnapshot("2026-07-28", [{ tag: "v1", asset: "b.ipa", cumulative: 5 }], []),
      buildSnapshot("2026-07-29", [{ tag: "v1", asset: "a.apk", cumulative: 1 }], []),
      buildSnapshot("2026-07-30", [{ tag: "v1", asset: "b.ipa", cumulative: 9 }], []),
    ];
    const reappear = computeAssetDailyDeltas(snapshots).find(
      (d) => d.date === "2026-07-30" && d.asset === "b.ipa",
    );
    // b.ipa's last observation was 2026-07-28 (two days back), so the +4 cannot
    // be attributed to a single day.
    expect(reappear?.delta).toBeNull();
    expect(reappear?.cumulative).toBe(9);
  });

  test("computeAssetDailyDeltas: a missing intermediate snapshot makes the delta null, not the full jump", () => {
    // Jul 29 then Jul 31 — Jul 30 snapshot is missing entirely.
    const snapshots = [
      buildSnapshot("2026-07-29", [{ tag: "v1", asset: "a.apk", cumulative: 100 }], []),
      buildSnapshot("2026-07-31", [{ tag: "v1", asset: "a.apk", cumulative: 140 }], []),
    ];
    const day3 = computeAssetDailyDeltas(snapshots).find((d) => d.date === "2026-07-31");
    expect(day3?.delta).toBeNull(); // not 40
    expect(day3?.cumulative).toBe(140);
  });

  test("utcDayDifference counts whole UTC days between YYYY-MM-DD dates", () => {
    expect(utcDayDifference("2026-07-29", "2026-07-30")).toBe(1);
    expect(utcDayDifference("2026-07-29", "2026-07-31")).toBe(2);
    expect(utcDayDifference("2026-07-31", "2026-08-01")).toBe(1); // month boundary
    expect(utcDayDifference("2026-07-30", "2026-07-30")).toBe(0);
  });

  test("excludeIncompleteNpmDay drops the current UTC day, keeps complete days", () => {
    const npm = [
      { day: "2026-07-29", downloads: 652 },
      { day: "2026-07-30", downloads: 1013 },
      { day: "2026-07-31", downloads: 300 }, // partial — collector ran mid-day
    ];
    const trimmed = excludeIncompleteNpmDay(npm, new Date("2026-07-31T05:17:00.000Z"));
    expect(trimmed.map((n) => n.day)).toEqual(["2026-07-29", "2026-07-30"]);
  });

  test("parseSnapshots on an empty document yields no snapshots (empty production data file)", () => {
    expect(parseSnapshots("")).toEqual([]);
  });

  test("SAMPLE_SNAPSHOTS fixture parses cleanly and preserves three days of history", () => {
    // The synthetic sample formerly shipped in docs/metrics/data/downloads.jsonl.
    // It lives here now so the production data file can start empty.
    const parsed = parseSnapshots(SAMPLE_SNAPSHOTS_JSONL);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((s) => s.date)).toEqual(["2026-07-29", "2026-07-30", "2026-07-31"]);
  });
});

describe("classifyAssetType", () => {
  test("maps every real asset name to its stable family", () => {
    expect(classifyAssetType("control-proxy-debug.apk")).toBe("android-apk");
    expect(classifyAssetType("control-proxy.ipa")).toBe("ios-ipa");
    expect(classifyAssetType("automobile-video.jar")).toBe("video-jar");
    expect(classifyAssetType("AutoMobile-0.0.48-linux.deb")).toBe("desktop-installer");
    expect(classifyAssetType("AutoMobile-0.0.48-macos.dmg")).toBe("desktop-installer");
    expect(classifyAssetType("AutoMobile-0.0.48-windows.msi")).toBe("desktop-installer");
    expect(classifyAssetType("screen-capture-helper-macos-universal.zip")).toBe(
      "screen-capture-helper",
    );
  });

  test("classifies desktop installers by extension regardless of embedded version", () => {
    // A future release's installer keeps the family without a code change.
    expect(classifyAssetType("AutoMobile-1.2.3-linux.deb")).toBe("desktop-installer");
  });

  test("unknown asset names fall back to 'other' rather than throwing", () => {
    expect(classifyAssetType("something-new.tar.gz")).toBe("other");
  });
});

describe("summarizeDailyByAssetType", () => {
  test("sums daily deltas across releases into one series per family", () => {
    const snapshots = [
      buildSnapshot(
        "2026-07-29",
        [
          { tag: "v2", asset: "control-proxy-debug.apk", cumulative: 100, id: 1 },
          { tag: "v1", asset: "control-proxy-debug.apk", cumulative: 500, id: 2 },
          { tag: "v2", asset: "control-proxy.ipa", cumulative: 50, id: 3 },
        ],
        [],
      ),
      buildSnapshot(
        "2026-07-30",
        [
          { tag: "v2", asset: "control-proxy-debug.apk", cumulative: 110, id: 1 }, // +10
          { tag: "v1", asset: "control-proxy-debug.apk", cumulative: 505, id: 2 }, // +5
          { tag: "v2", asset: "control-proxy.ipa", cumulative: 57, id: 3 }, // +7
        ],
        [],
      ),
    ];
    const result = summarizeDailyByAssetType(snapshots);
    expect(result.dates).toEqual(["2026-07-29", "2026-07-30"]);

    const apk = result.series.find((s) => s.type === "android-apk");
    // Day 0 is all seed (null) → downloads 0 but partial; day 1 sums both releases.
    expect(apk?.points[0]).toMatchObject({ downloads: 0, partial: true });
    expect(apk?.points[1]).toMatchObject({ downloads: 15, partial: false });
    expect(apk?.total).toBe(15);

    const ipa = result.series.find((s) => s.type === "ios-ipa");
    expect(ipa?.points[1].downloads).toBe(7);
  });

  test("a null delta within a family flags the day partial and is excluded from the sum", () => {
    const snapshots = [
      buildSnapshot(
        "2026-07-29",
        [
          { tag: "v1", asset: "a.apk", cumulative: 10, id: 1 },
          { tag: "v2", asset: "b.apk", cumulative: 20, id: 2 },
        ],
        [],
      ),
      buildSnapshot(
        "2026-07-30",
        [
          { tag: "v1", asset: "a.apk", cumulative: 18, id: 1 }, // +8, known
          { tag: "v2", asset: "b.apk", cumulative: 5, id: 2 }, // reset → null
        ],
        [],
      ),
    ];
    const apk = summarizeDailyByAssetType(snapshots).series.find((s) => s.type === "android-apk");
    // Only the known +8 is summed; the reset asset is excluded but flags partial.
    expect(apk?.points[1]).toMatchObject({ downloads: 8, partial: true, observed: true });
  });

  test("orders families by ASSET_TYPE_ORDER and omits families with no data", () => {
    const snapshots = [
      buildSnapshot("2026-07-29", [{ tag: "v1", asset: "a.ipa", cumulative: 1 }], []),
      buildSnapshot("2026-07-30", [{ tag: "v1", asset: "a.ipa", cumulative: 4 }], []),
    ];
    const result = summarizeDailyByAssetType(snapshots);
    expect(result.series.map((s) => s.type)).toEqual(["ios-ipa"]);
  });
});

describe("summarizeCumulativeByTag", () => {
  test("sums cumulative across a tag's assets and one line per tag", () => {
    const snapshots = [
      buildSnapshot(
        "2026-07-29",
        [
          { tag: "0.0.47", asset: "a.apk", cumulative: 100 },
          { tag: "0.0.47", asset: "a.ipa", cumulative: 40 },
          { tag: "0.0.46", asset: "a.apk", cumulative: 900 },
        ],
        [],
      ),
    ];
    const result = summarizeCumulativeByTag(snapshots);
    const newest = result.series.find((s) => s.tag === "0.0.47");
    expect(newest?.points[0].value).toBe(140); // 100 + 40
    expect(newest?.latest).toBe(140);
  });

  test("newest release first (version-aware: 0.0.100 > 0.0.47) and maxTags caps the set", () => {
    const snapshots = [
      buildSnapshot(
        "2026-07-29",
        [
          { tag: "0.0.47", asset: "a.apk", cumulative: 1 },
          { tag: "0.0.100", asset: "a.apk", cumulative: 1 },
          { tag: "0.0.46", asset: "a.apk", cumulative: 1 },
        ],
        [],
      ),
    ];
    const capped = summarizeCumulativeByTag(snapshots, 2);
    expect(capped.series.map((s) => s.tag)).toEqual(["0.0.100", "0.0.47"]);
  });

  test("a tag absent from a snapshot has a null point so the line breaks, not drops to zero", () => {
    const snapshots = [
      buildSnapshot("2026-07-29", [{ tag: "0.0.46", asset: "a.apk", cumulative: 900 }], []),
      // 0.0.47 first appears the next day.
      buildSnapshot(
        "2026-07-30",
        [
          { tag: "0.0.46", asset: "a.apk", cumulative: 905 },
          { tag: "0.0.47", asset: "a.apk", cumulative: 30 },
        ],
        [],
      ),
    ];
    const result = summarizeCumulativeByTag(snapshots);
    const newest = result.series.find((s) => s.tag === "0.0.47");
    expect(newest?.points[0].value).toBeNull(); // did not exist on day 0
    expect(newest?.points[1].value).toBe(30);
    expect(newest?.latest).toBe(30);
  });
});

describe("compareTagsDesc", () => {
  test("sorts version tags numerically newest-first, tolerating a leading v", () => {
    const tags = ["v0.0.47", "0.0.100", "0.0.9", "0.0.46"];
    expect([...tags].sort(compareTagsDesc)).toEqual(["0.0.100", "v0.0.47", "0.0.46", "0.0.9"]);
  });
});

describe("rollingAverage", () => {
  test("trailing mean with min-periods 1", () => {
    expect(rollingAverage([2, 4, 6], 3)).toEqual([2, 3, 4]);
  });

  test("window larger than the tail averages only available values", () => {
    // i=3 window of 3 = mean(4,6,8) = 6.
    expect(rollingAverage([2, 4, 6, 8], 3)).toEqual([2, 3, 4, 6]);
  });

  test("smooths a zero-day spike without dividing by zero on an empty series", () => {
    expect(rollingAverage([], 7)).toEqual([]);
    expect(rollingAverage([10, 0, 10], 2)).toEqual([10, 5, 5]);
  });
});

describe("collect() CLI wiring with fakes", () => {
  const DATA_FILE = "/repo/docs/metrics/data/downloads.jsonl";

  test("writes today's snapshot and is idempotent on re-run (no duplicate date)", async () => {
    const files = fakeFiles();
    const now = new Date("2026-07-31T06:00:00.000Z");

    const sources1 = fakeSources(
      [{ tag: "v0.0.45", asset: "control-proxy.apk", cumulative: 10 }],
      [{ day: "2026-07-30", downloads: 500 }],
    );
    const first = await collect(sources1, files, DATA_FILE, now);
    expect(first.date).toBe("2026-07-31");

    // Re-run same UTC date with a higher cumulative — must overwrite, not append.
    const sources2 = fakeSources(
      [{ tag: "v0.0.45", asset: "control-proxy.apk", cumulative: 14 }],
      [{ day: "2026-07-30", downloads: 500 }],
    );
    await collect(sources2, files, DATA_FILE, now);

    const snapshots = parseSnapshots(files.store.get(DATA_FILE) ?? "");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].date).toBe("2026-07-31");
    expect(snapshots[0].github[0].cumulative).toBe(14);
  });

  test("first run (ENOENT) writes a fresh single-snapshot file", async () => {
    const files = fakeFiles(); // no seed => readFile rejects ENOENT
    const now = new Date("2026-07-31T06:00:00.000Z");
    const sources = fakeSources(
      [{ tag: "v0.0.45", asset: "control-proxy.apk", cumulative: 7 }],
      [{ day: "2026-07-30", downloads: 42 }],
    );

    const result = await collect(sources, files, DATA_FILE, now);
    expect(result).toEqual({ date: "2026-07-31", wrote: true });

    const snapshots = parseSnapshots(files.store.get(DATA_FILE) ?? "");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].github[0].cumulative).toBe(7);
    expect(snapshots[0].npm).toEqual([{ day: "2026-07-30", downloads: 42 }]);
  });

  test("read failure other than ENOENT propagates (does not silently reseed)", async () => {
    const files = fakeFiles();
    files.readFile = async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    const now = new Date("2026-07-31T06:00:00.000Z");
    const sources = fakeSources(
      [{ tag: "v0.0.45", asset: "control-proxy.apk", cumulative: 10 }],
      [{ day: "2026-07-30", downloads: 5 }],
    );
    await expect(collect(sources, files, DATA_FILE, now)).rejects.toThrow();
  });

  test("npm-source failure still writes a GitHub-only snapshot (failures are decoupled)", async () => {
    const files = fakeFiles();
    const now = new Date("2026-07-31T06:00:00.000Z");

    const sources: DownloadSources = {
      fetchGithubAssetCounts: async () => [
        { tag: "v0.0.45", asset: "control-proxy.apk", cumulative: 10 },
      ],
      fetchNpmDailyCounts: async () => {
        throw new Error("npm 503");
      },
    };
    const result = await collect(sources, files, DATA_FILE, now);
    expect(result.date).toBe("2026-07-31");

    const snapshots = parseSnapshots(files.store.get(DATA_FILE) ?? "");
    expect(snapshots).toHaveLength(1);
    // GitHub data survived the npm failure; npm degraded to empty for the day.
    expect(snapshots[0].github[0].cumulative).toBe(10);
    expect(snapshots[0].npm).toEqual([]);
  });

  test("npm-source failure preserves the existing same-date npm counts", async () => {
    const now = new Date("2026-07-31T06:00:00.000Z");
    // An earlier run today already stored good npm counts for 2026-07-31.
    const seeded = serializeSnapshots([
      buildSnapshot(
        "2026-07-31",
        [{ tag: "v0.0.45", asset: "control-proxy.apk", cumulative: 9 }],
        [{ day: "2026-07-30", downloads: 500 }],
      ),
    ]);
    const files = fakeFiles({ [DATA_FILE]: seeded });

    const sources: DownloadSources = {
      fetchGithubAssetCounts: async () => [
        { tag: "v0.0.45", asset: "control-proxy.apk", cumulative: 12 },
      ],
      fetchNpmDailyCounts: async () => {
        throw new Error("npm 503");
      },
    };
    await collect(sources, files, DATA_FILE, now);

    const snapshots = parseSnapshots(files.store.get(DATA_FILE) ?? "");
    expect(snapshots).toHaveLength(1);
    // GitHub cumulative advanced, but the good npm from the earlier run survives
    // — it is NOT clobbered with [].
    expect(snapshots[0].github[0].cumulative).toBe(12);
    expect(snapshots[0].npm).toEqual([{ day: "2026-07-30", downloads: 500 }]);
  });

  test("GitHub-source failure fails the run (no useful snapshot)", async () => {
    const files = fakeFiles();
    const now = new Date("2026-07-31T06:00:00.000Z");
    const sources: DownloadSources = {
      fetchGithubAssetCounts: async () => {
        throw new Error("github 500");
      },
      fetchNpmDailyCounts: async () => [{ day: "2026-07-30", downloads: 5 }],
    };
    await expect(collect(sources, files, DATA_FILE, now)).rejects.toThrow();
  });

  test("drops the incomplete current UTC day from stored npm counts", async () => {
    const files = fakeFiles();
    const now = new Date("2026-07-31T05:17:00.000Z");

    const sources = fakeSources(
      [{ tag: "v0.0.45", asset: "control-proxy.apk", cumulative: 10 }],
      [
        { day: "2026-07-30", downloads: 1013 },
        { day: "2026-07-31", downloads: 200 }, // partial day the job ran on
      ],
    );
    await collect(sources, files, DATA_FILE, now);

    const snapshots = parseSnapshots(files.store.get(DATA_FILE) ?? "");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].npm.map((n) => n.day)).toEqual(["2026-07-30"]);
  });
});
