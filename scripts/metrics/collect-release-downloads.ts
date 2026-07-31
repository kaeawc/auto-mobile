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
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ActionableError, toActionableError } from "../../src/models/ActionableError";
import {
  buildSnapshot,
  excludeIncompleteNpmDay,
  mergeSnapshot,
  parseSnapshots,
  serializeSnapshots,
  utcDateString,
  type DownloadSnapshot,
  type DownloadSources,
  type FileStore,
  type GithubAssetCount,
  type NpmDayCount,
} from "../../src/metrics/downloadSnapshots";

const REPO = "kaeawc/auto-mobile";
const NPM_PACKAGE = "@kaeawc/auto-mobile";
const NPM_WINDOW_DAYS = 90;
// Per-request deadline so a source that stalls without settling can't hang the
// job (and, via Promise.allSettled, block the GitHub-only degradation path). A
// timed-out fetch aborts and is handled like any other fetch failure.
const REQUEST_TIMEOUT_MS = Number(process.env.METRICS_REQUEST_TIMEOUT_MS ?? 20000);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(scriptDir, "..", "..");
const DATA_FILE = path.join(REPO_ROOT, "docs", "metrics", "data", "downloads.jsonl");

interface GithubReleaseAsset {
  id: number;
  name: string;
  download_count: number;
}

interface GithubRelease {
  tag_name: string;
  draft: boolean;
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

/** Bounded retry for the GitHub releases fetch. */
const GITHUB_FETCH_ATTEMPTS = 3;
const GITHUB_RETRY_BASE_MS = 500;

/**
 * Fetch a GitHub releases page, retrying transient failures (a network throw or
 * a 5xx response) up to {@link GITHUB_FETCH_ATTEMPTS} times with a small linear
 * backoff. A 4xx response (auth/not-found) is not transient, so it fails fast
 * without retrying. Returns the parsed release list for the page.
 */
async function fetchGithubReleasesPage(url: string, page: number): Promise<GithubRelease[]> {
  const headers = githubHeaders();
  let lastError: unknown;
  for (let attempt = 1; attempt <= GITHUB_FETCH_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        // Parse the body INSIDE the retryable attempt: a connection failure while
        // reading the body is just as transient as one during the fetch, so it
        // must retry rather than abort collection with attempts still remaining.
        return (await response.json()) as GithubRelease[];
      }
    } catch (error) {
      // Network-level throw during the fetch OR the body read: transient, so
      // retry until attempts are exhausted.
      lastError = error;
      if (attempt < GITHUB_FETCH_ATTEMPTS) {
        await sleep(GITHUB_RETRY_BASE_MS * attempt);
        continue;
      }
      throw toActionableError(error, `Failed to fetch GitHub releases page ${page}`);
    }
    // Reached only when the response arrived but is not ok (response is assigned).
    // 4xx (auth/not-found) is not transient — fail fast without retrying.
    if (response.status < 500) {
      throw new ActionableError(
        `GitHub releases request failed (page ${page}): ${response.status} ${response.statusText}`
      );
    }
    // 5xx is transient: retry, remembering the last status for the final error.
    lastError = new ActionableError(
      `GitHub releases request failed (page ${page}): ${response.status} ${response.statusText}`
    );
    if (attempt < GITHUB_FETCH_ATTEMPTS) {
      await sleep(GITHUB_RETRY_BASE_MS * attempt);
    }
  }
  throw toActionableError(lastError, `Failed to fetch GitHub releases page ${page} after retries`);
}

/** Fetch every release asset's cumulative download count, paginating fully. */
async function fetchGithubAssetCounts(): Promise<GithubAssetCount[]> {
  const counts: GithubAssetCount[] = [];
  for (let page = 1; ; page++) {
    const url = `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`;
    const releases = await fetchGithubReleasesPage(url, page);
    if (releases.length === 0) {
      break;
    }
    for (const release of releases) {
      // The authenticated releases endpoint returns drafts to callers with push
      // access (this job's token has it); never publish unreleased draft metadata
      // to the public dashboard.
      if (release.draft) {
        continue;
      }
      for (const asset of release.assets ?? []) {
        counts.push({
          tag: release.tag_name,
          asset: asset.name,
          cumulative: asset.download_count ?? 0,
          // Pin the counter's identity: a deleted+re-uploaded asset gets a new
          // id, letting the delta logic reject a replacement's cumulative jump.
          id: asset.id,
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
  // Percent-encode the scoped package so the "/" is not read as a path separator.
  // The unencoded form currently also resolves, but the encoded form is the
  // documented contract; both return 200 today.
  const url = `https://api.npmjs.org/downloads/range/${range}/${encodeURIComponent(NPM_PACKAGE)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": "auto-mobile-download-metrics" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
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

/** Real filesystem seam backed by `node:fs/promises` for the CLI. */
const realFiles: FileStore = {
  readFile: filePath => readFile(filePath, "utf8"),
  mkdir: async dir => {
    await mkdir(dir, { recursive: true });
  },
  writeFile: (filePath, data) => writeFile(filePath, data, "utf8"),
};

/**
 * Run the collector: fetch both sources, merge today's snapshot into the JSONL
 * file idempotently, and write it back. Returns the snapshot that was written.
 * I/O is injected via {@link FileStore} so tests need no real temp dirs.
 */
export async function collect(
  sources: DownloadSources,
  files: FileStore,
  dataFile: string,
  now: Date
): Promise<{ date: string; wrote: boolean }> {
  // Fetch the two independent sources without coupling their failure modes: a
  // transient npm outage must not discard GitHub counts we already have.
  const [githubResult, npmResult] = await Promise.allSettled([
    sources.fetchGithubAssetCounts(),
    sources.fetchNpmDailyCounts(),
  ]);

  // GitHub cumulative counts are the core metric; without them there is no useful
  // snapshot, so a GitHub failure fails the run (it retries on the next schedule).
  if (githubResult.status === "rejected") {
    throw toActionableError(githubResult.reason, "Failed to fetch GitHub release download counts");
  }
  const github = githubResult.value;

  const date = utcDateString(now);

  // Read-then-handle-ENOENT rather than existsSync-then-read: a single syscall
  // with no check-then-use gap, so there is no file-system race (CodeQL
  // js/file-system-race). Absent file on the first run => empty history.
  let existing: DownloadSnapshot[] = [];
  try {
    existing = parseSnapshots(await files.readFile(dataFile));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw toActionableError(error, `Failed to read existing snapshots from ${dataFile}`);
    }
  }

  // npm is best-effort. On success, drop the incomplete current UTC day (the job
  // runs a few hours into the day, so today's count is partial). On failure,
  // reuse the existing same-date record's npm rather than clobbering good data
  // with []; that stored array was already complete-day-filtered, so it must NOT
  // be re-filtered here. Fall back to [] only when there is no record for today.
  let npm: NpmDayCount[];
  if (npmResult.status === "fulfilled") {
    npm = excludeIncompleteNpmDay(npmResult.value, now);
  } else {
    const priorToday = existing.find(snapshot => snapshot.date === date);
    npm = priorToday?.npm ?? [];
    process.stderr.write(
      `WARN: npm download fetch failed for ${date}; ` +
        `${priorToday ? "reusing the existing same-date npm counts" : "writing GitHub-only snapshot"}. ` +
        `${String(npmResult.reason)}\n`
    );
  }

  const snapshot = buildSnapshot(date, github, npm);
  const merged = mergeSnapshot(existing, snapshot);
  const serialized = serializeSnapshots(merged);

  await files.mkdir(path.dirname(dataFile));
  await files.writeFile(dataFile, serialized);

  return { date, wrote: true };
}

async function main(): Promise<void> {
  const result = await collect(realSources, realFiles, DATA_FILE, new Date());
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
