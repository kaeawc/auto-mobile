/**
 * Pure logic for the release-download metrics dashboard.
 *
 * GitHub's REST API exposes only the CUMULATIVE `download_count` per release
 * asset — there is no per-day history. Daily figures are therefore obtained by
 * snapshotting the cumulative count on a schedule and diffing consecutive
 * snapshots. npm is different: its range API returns true daily counts, which
 * we store verbatim.
 *
 * Everything here is pure and synchronous so it can be unit-tested with fakes
 * and never touches the network or the filesystem. The CLI
 * (`scripts/metrics/collect-release-downloads.ts`) wires the real HTTP fetchers
 * behind {@link DownloadSources}; tests inject fakes.
 */

/** A single release asset's cumulative download count at snapshot time. */
export interface GithubAssetCount {
  /** Release tag, e.g. `v0.0.45`. */
  tag: string;
  /** Asset file name, e.g. `auto-mobile-control-proxy.apk`. */
  asset: string;
  /** Cumulative download count reported by the GitHub API. */
  cumulative: number;
  /**
   * The GitHub asset id. Optional so the empty production file and older
   * fixtures (written before ids were recorded) still parse. When present, it
   * pins the counter's identity: an asset deleted and re-uploaded under the same
   * tag+filename gets a NEW id, so a changed id across snapshots means the
   * cumulative counter was reset even if the value did not decrease. See
   * {@link computeAssetDailyDeltas}.
   */
  id?: number;
}

/** A single day's npm download count (true daily value from the npm API). */
export interface NpmDayCount {
  /** ISO date `YYYY-MM-DD`. */
  day: string;
  /** Downloads on that day. */
  downloads: number;
}

/** One dated snapshot record — the unit appended to `downloads.jsonl`. */
export interface DownloadSnapshot {
  /** UTC date `YYYY-MM-DD` the snapshot was taken. */
  date: string;
  /** Per-asset cumulative GitHub counts at snapshot time. */
  github: GithubAssetCount[];
  /** npm daily counts (a rolling window; true daily values). */
  npm: NpmDayCount[];
}

/** Injected HTTP sources so the collector can be tested without the network. */
export interface DownloadSources {
  /** Fetch every release asset's cumulative download count. */
  fetchGithubAssetCounts(): Promise<GithubAssetCount[]>;
  /** Fetch npm daily download counts for the tracked window. */
  fetchNpmDailyCounts(): Promise<NpmDayCount[]>;
}

/**
 * Injected filesystem seam so the collector can be unit-tested with an in-memory
 * fake instead of real temp dirs. The CLI wires a `node:fs/promises`-backed
 * implementation; tests inject a `Map`-backed fake.
 */
export interface FileStore {
  /** Read a UTF-8 file; rejects with a `{ code: "ENOENT" }` error when absent. */
  readFile(path: string): Promise<string>;
  /** Create a directory (recursively); a no-op when it already exists. */
  mkdir(dir: string): Promise<void>;
  /** Write a UTF-8 file, overwriting any existing content. */
  writeFile(path: string, data: string): Promise<void>;
}

/** A daily delta derived from two consecutive cumulative snapshots. */
export interface AssetDailyDelta {
  tag: string;
  asset: string;
  /** The date the delta is attributed to (the later snapshot's date). */
  date: string;
  /** Cumulative count on that date. */
  cumulative: number;
  /**
   * Downloads attributed to that day: later.cumulative - earlier.cumulative.
   * Null when a true daily delta is unknowable and must not be invented:
   *   - the first snapshot in which the asset appears (day-0 seed), or
   *   - the prior observation is NOT the immediately preceding calendar day, so
   *     a multi-day increase cannot be honestly attributed to a single day, or
   *   - the cumulative count DECREASED (asset re-published / counter reset), so
   *     the true daily count is unknowable — reported as null, not a false 0, or
   *   - the GitHub asset id CHANGED between the two observations (asset deleted
   *     and re-uploaded under the same tag+filename gets a new id), so the two
   *     cumulative counts belong to different counters — reported as null even
   *     when the value did not decrease.
   */
  delta: number | null;
}

/**
 * The `YYYY-MM-DD` UTC date for an instant. Injected as an argument rather than
 * read from the clock so callers stay deterministic.
 */
export function utcDateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Whole-day difference between two `YYYY-MM-DD` UTC dates (`later - earlier`).
 * Both are interpreted at UTC midnight, so DST and local offsets never apply.
 */
export function utcDayDifference(earlier: string, later: string): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const a = Date.parse(`${earlier}T00:00:00.000Z`);
  const b = Date.parse(`${later}T00:00:00.000Z`);
  return Math.round((b - a) / MS_PER_DAY);
}

/**
 * Drop the current UTC day's npm entry. The collector requests the npm range
 * through "today", but the job runs a few hours into the UTC day, so today's
 * count is partial and would be mislabeled as a full day. Only complete days
 * are stored. Pure — `now` is injected.
 */
export function excludeIncompleteNpmDay(npm: NpmDayCount[], now: Date): NpmDayCount[] {
  const today = utcDateString(now);
  return npm.filter((entry) => entry.day !== today);
}

/**
 * Build the snapshot record for a single UTC date from freshly-fetched source
 * data. Pure — the fetch already happened.
 */
export function buildSnapshot(
  date: string,
  github: GithubAssetCount[],
  npm: NpmDayCount[],
): DownloadSnapshot {
  return { date, github, npm };
}

/**
 * Merge a new snapshot into the existing ordered list of snapshots,
 * idempotently by UTC date. A record for the same `date` is OVERWRITTEN in
 * place (never duplicated), so re-running the collector on the same day is
 * safe. The result is sorted ascending by date.
 */
export function mergeSnapshot(
  existing: DownloadSnapshot[],
  incoming: DownloadSnapshot,
): DownloadSnapshot[] {
  const byDate = new Map<string, DownloadSnapshot>();
  for (const snapshot of existing) {
    byDate.set(snapshot.date, snapshot);
  }
  byDate.set(incoming.date, incoming);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Serialize snapshots to JSONL (one JSON object per line, trailing newline).
 * Sorted ascending by date for a stable, diff-friendly file.
 */
export function serializeSnapshots(snapshots: DownloadSnapshot[]): string {
  const ordered = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  return ordered.map((snapshot) => JSON.stringify(snapshot)).join("\n") + "\n";
}

/**
 * Parse a `downloads.jsonl` document into snapshots. Blank lines are skipped so
 * a trailing newline (or a hand-edited file) parses cleanly.
 */
export function parseSnapshots(jsonl: string): DownloadSnapshot[] {
  return jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DownloadSnapshot);
}

/** Stable identity for an asset across snapshots. */
function assetKey(tag: string, asset: string): string {
  return `${tag}\u0000${asset}`;
}

/**
 * Derive per-asset daily deltas across the full snapshot history by diffing
 * each asset's cumulative count against its value in the previous snapshot.
 *
 * - The first snapshot in which an asset appears yields `delta: null` (day-0
 *   seed; the true daily value is unrecoverable).
 * - A prior observation more than one calendar day back yields `delta: null`:
 *   an intermediate snapshot is missing, so the multi-day increase cannot be
 *   honestly attributed to a single day (rendered as a gap).
 * - A drop in cumulative (asset re-published, counter reset) yields `delta: null`
 *   (unknown) rather than asserting a false daily count of 0 or a negative delta.
 * - The GitHub asset id CHANGED between the two observations (deleted and
 *   re-uploaded under the same tag+filename) yields `delta: null`: the counts
 *   belong to different counters, so a non-decreasing replacement (e.g. 5 -> 8)
 *   must not fabricate a delta the decrease guard cannot catch.
 * - An asset absent from a later snapshot simply produces no row for that date;
 *   its history is not carried forward.
 */
export function computeAssetDailyDeltas(snapshots: DownloadSnapshot[]): AssetDailyDelta[] {
  const ordered = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const previous = new Map<string, { cumulative: number; date: string; id?: number }>();
  const deltas: AssetDailyDelta[] = [];

  for (const snapshot of ordered) {
    for (const entry of snapshot.github) {
      const key = assetKey(entry.tag, entry.asset);
      const prior = previous.get(key);
      let delta: number | null;
      if (prior === undefined || utcDayDifference(prior.date, snapshot.date) !== 1) {
        delta = null;
      } else if (prior.id !== undefined && entry.id !== undefined && prior.id !== entry.id) {
        // The asset id changed (deleted + re-uploaded), so the two cumulative
        // counts belong to different counters; the daily count is unknowable.
        delta = null;
      } else {
        const change = entry.cumulative - prior.cumulative;
        // A decrease means the counter reset (asset re-published); the true daily
        // count is unknowable, so report null rather than a false 0.
        delta = change < 0 ? null : change;
      }
      deltas.push({
        tag: entry.tag,
        asset: entry.asset,
        date: snapshot.date,
        cumulative: entry.cumulative,
        delta,
      });
      previous.set(key, { cumulative: entry.cumulative, date: snapshot.date, id: entry.id });
    }
  }

  return deltas;
}

/**
 * Asset "family" keys. The dashboard's headline chart collapses the per-release
 * dimension and instead groups downloads by the KIND of artifact, so a reader
 * sees total artifact pull and its platform mix over time regardless of how many
 * releases exist. Families are stable across releases even though some asset file
 * names embed the version (e.g. `AutoMobile-0.0.48-macos.dmg`).
 */
export type AssetTypeKey =
  | "android-apk"
  | "ios-ipa"
  | "desktop-installer"
  | "video-jar"
  | "screen-capture-helper"
  | "other";

/** Stable stacking / legend order (bottom-to-top in the stacked chart). */
export const ASSET_TYPE_ORDER: readonly AssetTypeKey[] = [
  "android-apk",
  "ios-ipa",
  "desktop-installer",
  "video-jar",
  "screen-capture-helper",
  "other",
];

/** Human-readable labels for each asset family. */
export const ASSET_TYPE_LABELS: Record<AssetTypeKey, string> = {
  "android-apk": "Android APK",
  "ios-ipa": "iOS IPA",
  "desktop-installer": "Desktop installers",
  "video-jar": "Video jar",
  "screen-capture-helper": "Screen-capture helper",
  other: "Other",
};

/**
 * Map an asset file name to its family. Extension-driven so a future release
 * whose installer keeps the same suffix (`.deb`/`.dmg`/`.msi`) classifies without
 * a code change; the version embedded in some names is irrelevant to the family.
 * The `screen-capture-helper` prefix is matched before the generic `.zip` fallback
 * so a differently-named future zip still lands somewhere sensible.
 */
export function classifyAssetType(asset: string): AssetTypeKey {
  const name = asset.toLowerCase();
  if (name.endsWith(".apk")) {
    return "android-apk";
  }
  if (name.endsWith(".ipa")) {
    return "ios-ipa";
  }
  if (name.endsWith(".deb") || name.endsWith(".dmg") || name.endsWith(".msi")) {
    return "desktop-installer";
  }
  if (name.endsWith(".jar")) {
    return "video-jar";
  }
  if (name.startsWith("screen-capture-helper") || name.endsWith(".zip")) {
    return "screen-capture-helper";
  }
  return "other";
}

/** One asset family's total for a single date on the shared date axis. */
export interface AssetTypeDailyValue {
  date: string;
  /** Sum of KNOWN daily deltas across this family's assets on this date. */
  downloads: number;
  /**
   * True when at least one contributing asset's delta was null (a day-0 seed,
   * a snapshot gap, or a counter reset). The `downloads` total then omits that
   * asset, so the day is a lower bound — the renderer marks it as partial rather
   * than plotting a misleadingly-low solid value.
   */
  partial: boolean;
  /** True when no asset of this family was observed at all on this date. */
  observed: boolean;
}

/** One asset family's aligned series across every snapshot date. */
export interface AssetTypeSeries {
  type: AssetTypeKey;
  label: string;
  /** One point per date in {@link DailyByAssetType.dates}, in the same order. */
  points: AssetTypeDailyValue[];
  /** Sum of `downloads` across all dates (known deltas only). */
  total: number;
}

/** Result of {@link summarizeDailyByAssetType}. */
export interface DailyByAssetType {
  /** Every snapshot date that produced at least one delta row, ascending. */
  dates: string[];
  /** Families that appear in the data, in {@link ASSET_TYPE_ORDER}. */
  series: AssetTypeSeries[];
}

/**
 * Collapse per-release, per-asset daily deltas into one daily series PER ASSET
 * FAMILY, summed across all releases. This is the headline "artifact downloads
 * over time" view: the version dimension disappears, leaving a small fixed set
 * of platform families that stays readable as releases accumulate.
 *
 * Null deltas (seed/gap/reset) are never invented as zero: they are excluded
 * from the family's `downloads` sum and flagged via `partial`, so a day missing
 * some observations reads as an honest lower bound rather than a dip.
 */
export function summarizeDailyByAssetType(snapshots: DownloadSnapshot[]): DailyByAssetType {
  const deltas = computeAssetDailyDeltas(snapshots);
  const dates = [...new Set(deltas.map((d) => d.date))].sort((a, b) => a.localeCompare(b));
  const acc = new Map<AssetTypeKey, Map<string, AssetTypeDailyValue>>();

  for (const d of deltas) {
    const type = classifyAssetType(d.asset);
    let byDate = acc.get(type);
    if (byDate === undefined) {
      byDate = new Map<string, AssetTypeDailyValue>();
      acc.set(type, byDate);
    }
    const current = byDate.get(d.date) ?? {
      date: d.date,
      downloads: 0,
      partial: false,
      observed: false,
    };
    current.observed = true;
    if (d.delta === null) {
      current.partial = true;
    } else {
      current.downloads += d.delta;
    }
    byDate.set(d.date, current);
  }

  const series: AssetTypeSeries[] = [];
  for (const type of ASSET_TYPE_ORDER) {
    const byDate = acc.get(type);
    if (byDate === undefined) {
      continue;
    }
    let total = 0;
    const points = dates.map((date) => {
      const value = byDate.get(date);
      const downloads = value?.downloads ?? 0;
      total += downloads;
      return {
        date,
        downloads,
        partial: value?.partial ?? false,
        observed: value?.observed ?? false,
      };
    });
    series.push({ type, label: ASSET_TYPE_LABELS[type], points, total });
  }

  return { dates, series };
}

/**
 * Compare two release tags newest-first by numeric version segments, so `0.0.100`
 * sorts ahead of `0.0.47` (a lexical compare would invert them). A leading `v` is
 * ignored; non-numeric pre-release labels fall back to a reversed string compare.
 */
export function compareTagsDesc(a: string, b: string): number {
  const pa = String(a)
    .replace(/^v/, "")
    .split(/[.\-+]/);
  const pb = String(b)
    .replace(/^v/, "")
    .split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = parseInt(pa[i], 10);
    const nb = parseInt(pb[i], 10);
    if (!isNaN(na) && !isNaN(nb)) {
      if (na !== nb) {
        return nb - na;
      }
    } else {
      const sa = pa[i] || "";
      const sb = pb[i] || "";
      if (sa !== sb) {
        return sa < sb ? 1 : -1;
      }
    }
  }
  return 0;
}

/** One release tag's total cumulative downloads on a single date. */
export interface TagCumulativePoint {
  date: string;
  /**
   * Sum of cumulative counts across the tag's assets on this date, or null when
   * the tag was absent from that snapshot (the release did not exist yet, or was
   * dropped) — the renderer breaks the line rather than drawing to zero.
   */
  value: number | null;
}

/** One release tag's aligned cumulative series across every snapshot date. */
export interface TagCumulativeSeries {
  tag: string;
  /** One point per date in {@link CumulativeByTag.dates}, in the same order. */
  points: TagCumulativePoint[];
  /** The most recent non-null cumulative total (0 if the tag never had one). */
  latest: number;
}

/** Result of {@link summarizeCumulativeByTag}. */
export interface CumulativeByTag {
  dates: string[];
  /** Series in newest-release-first order, capped to `maxTags`. */
  series: TagCumulativeSeries[];
}

/**
 * Collapse the current per-release cumulative charts into ONE chart: a single
 * line per release tag of total cumulative downloads across that tag's assets.
 * This preserves the version-adoption story (newer releases climbing and
 * overtaking older ones) without emitting a separate chart per version.
 *
 * `maxTags` caps the series to the newest N releases so the legend stays
 * readable; older tags are dropped from the chart (not summed elsewhere).
 */
export function summarizeCumulativeByTag(
  snapshots: DownloadSnapshot[],
  maxTags?: number,
): CumulativeByTag {
  const ordered = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const dates = ordered.map((s) => s.date);
  const acc = new Map<string, Map<string, number>>();

  for (const snapshot of ordered) {
    for (const entry of snapshot.github) {
      let byDate = acc.get(entry.tag);
      if (byDate === undefined) {
        byDate = new Map<string, number>();
        acc.set(entry.tag, byDate);
      }
      byDate.set(snapshot.date, (byDate.get(snapshot.date) ?? 0) + entry.cumulative);
    }
  }

  let tags = [...acc.keys()].sort(compareTagsDesc);
  if (maxTags !== undefined && tags.length > maxTags) {
    tags = tags.slice(0, maxTags);
  }

  const series = tags.map((tag) => {
    const byDate = acc.get(tag) ?? new Map<string, number>();
    let latest = 0;
    const points = dates.map((date) => {
      const value = byDate.has(date) ? (byDate.get(date) ?? 0) : null;
      if (value !== null) {
        latest = value;
      }
      return { date, value };
    });
    return { tag, points, latest };
  });

  return { dates, series };
}

/**
 * Trailing simple moving average with a minimum-periods of 1: element `i` is the
 * mean of the window ending at `i` (up to `window` values, fewer near the start).
 * Used to smooth the noisy npm daily bars into a legible trend line. Pure; the
 * window is clamped to at least 1 so a bad argument can't divide by zero.
 */
export function rollingAverage(values: number[], window: number): number[] {
  const size = Math.max(1, Math.floor(window));
  const out: number[] = [];
  const q: number[] = [];
  let sum = 0;
  for (const v of values) {
    q.push(v);
    sum += v;
    if (q.length > size) {
      const removed = q.shift();
      if (removed !== undefined) {
        sum -= removed;
      }
    }
    out.push(sum / q.length);
  }
  return out;
}
