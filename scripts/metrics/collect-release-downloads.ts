#!/usr/bin/env bun
/**
 * Collect daily release-download metrics and append today's snapshot to
 * `docs/metrics/data/downloads.jsonl`.
 *
 * Source of truth (see src/metrics/downloadSnapshots.ts for the pure logic):
 *   - GitHub REST `download_count` per release asset is CUMULATIVE-only, so we
 *     snapshot it daily and diff snapshots at view time to recover dailies.
 *   - npm's range API returns TRUE daily counts, stored verbatim.
 *
 * Idempotent: re-running on the same UTC date OVERWRITES that date's record.
 *
 * Real HTTP fetchers are wired here; the merge/delta logic is pure and unit
 * tested with fakes (test/metrics/downloadSnapshots.test.ts) and never hits the
 * network.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ActionableError, toActionableError } from "../../src/models/ActionableError";
import {
  buildSnapshot,
  mergeSnapshot,
  parseSnapshots,
  serializeSnapshots,
  utcDateString,
  type DownloadSnapshot,
  type DownloadSources,
  type GithubAssetCount,
  type NpmDayCount,
} from "../../src/metrics/downloadSnapshots";

const REPO = "kaeawc/auto-mobile";
const NPM_PACKAGE = "@kaeawc/auto-mobile";
const NPM_WINDOW_DAYS = 90;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..", "..");
const DATA_FILE = path.join(REPO_ROOT, "docs", "metrics", "data", "downloads.jsonl");

interface GithubReleaseAsset {
  name: string;
  download_count: number;
}

interface GithubRelease {
  tag_name: string;
  assets: GithubReleaseAsset[];
}

/** Build the auth headers, preferring an env token so CI is not rate-limited. */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "auto-mobile-download-metrics",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** Fetch every release asset's cumulative download count, paginating fully. */
async function fetchGithubAssetCounts(): Promise<GithubAssetCount[]> {
  const counts: GithubAssetCount[] = [];
  const headers = githubHeaders();
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`;
    let response: Response;
    try {
      response = await fetch(url, { headers });
    } catch (error) {
      throw toActionableError(error, `Failed to fetch GitHub releases page ${page}`);
    }
    if (!response.ok) {
      throw new ActionableError(
        `GitHub releases request failed (page ${page}): ${response.status} ${response.statusText}`
      );
    }
    const releases = (await response.json()) as GithubRelease[];
    if (releases.length === 0) {
      break;
    }
    for (const release of releases) {
      for (const asset of release.assets ?? []) {
        counts.push({
          tag: release.tag_name,
          asset: asset.name,
          cumulative: asset.download_count ?? 0,
        });
      }
    }
    if (releases.length < 100) {
      break;
    }
  }
  return counts;
}

/** Fetch npm daily download counts for the tracked rolling window. */
async function fetchNpmDailyCounts(): Promise<NpmDayCount[]> {
  const to = new Date();
  const from = new Date(to.getTime() - NPM_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const range = `${utcDateString(from)}:${utcDateString(to)}`;
  const url = `https://api.npmjs.org/downloads/range/${range}/${NPM_PACKAGE}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { "User-Agent": "auto-mobile-download-metrics" } });
  } catch (error) {
    throw toActionableError(error, "Failed to fetch npm download range");
  }
  if (!response.ok) {
    // A brand-new package with no download history returns 404; treat as empty
    // rather than failing the whole collection.
    if (response.status === 404) {
      return [];
    }
    throw new ActionableError(
      `npm download range request failed: ${response.status} ${response.statusText}`
    );
  }
  const body = (await response.json()) as { downloads?: NpmDayCount[] };
  return (body.downloads ?? []).map(entry => ({ day: entry.day, downloads: entry.downloads }));
}

const realSources: DownloadSources = { fetchGithubAssetCounts, fetchNpmDailyCounts };

/**
 * Run the collector: fetch both sources, merge today's snapshot into the JSONL
 * file idempotently, and write it back. Returns the snapshot that was written.
 */
export async function collect(
  sources: DownloadSources,
  dataFile: string,
  now: Date
): Promise<{ date: string; wrote: boolean }> {
  const [github, npm] = await Promise.all([
    sources.fetchGithubAssetCounts(),
    sources.fetchNpmDailyCounts(),
  ]);

  const date = utcDateString(now);
  const snapshot = buildSnapshot(date, github, npm);

  // Read-then-handle-ENOENT rather than existsSync-then-read: a single syscall
  // with no check-then-use gap, so there is no file-system race (CodeQL
  // js/file-system-race). Absent file on the first run => empty history.
  let existing: DownloadSnapshot[] = [];
  try {
    existing = parseSnapshots(await readFile(dataFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw toActionableError(error, `Failed to read existing snapshots from ${dataFile}`);
    }
  }
  const merged = mergeSnapshot(existing, snapshot);
  const serialized = serializeSnapshots(merged);

  await mkdir(path.dirname(dataFile), { recursive: true });
  await writeFile(dataFile, serialized, "utf8");

  return { date, wrote: true };
}

async function main(): Promise<void> {
  const result = await collect(realSources, DATA_FILE, new Date());
  process.stdout.write(
    `Wrote snapshot for ${result.date} to ${path.relative(REPO_ROOT, DATA_FILE)}\n`
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    throw toActionableError(error, "Release download metrics collection failed");
  }
}
