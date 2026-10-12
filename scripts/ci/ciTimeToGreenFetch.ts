/**
 * Read-only GitHub fetch layer for `scripts/ci/ci-time-to-green.ts` (#11582).
 *
 * Every call is a GET through the injected `GhApi`; completed-run job pages and closed PRs are
 * cached item by item through the injected `CacheStore`, so a run that stops on the API budget or a
 * rate limit resumes where it stopped.
 */
import type { Bundle, JobFact, PrFact, RunFact } from "./ciTimeToGreenReport";
import type { PathClassifier } from "./prPathClassification";

export interface GhApi {
  get(path: string): Promise<unknown>;
}

export interface CacheStore {
  read(key: string): unknown | undefined;
  write(key: string, value: unknown): void;
}

/** The API refused further calls (rate limit) or the per-invocation call budget ran out. */
export class FetchStoppedError extends Error {
  constructor(
    readonly reason: "rate-limit" | "budget",
    message: string,
  ) {
    super(message);
    this.name = "FetchStoppedError";
  }
}

export class BudgetedGhApi implements GhApi {
  calls = 0;

  constructor(
    private readonly inner: GhApi,
    private readonly maxCalls: number,
  ) {}

  async get(path: string): Promise<unknown> {
    if (this.calls >= this.maxCalls) {
      throw new FetchStoppedError("budget", `API call budget of ${this.maxCalls} reached`);
    }
    this.calls += 1;
    return this.inner.get(path);
  }
}

interface RawJob {
  id: number;
  name: string;
  run_attempt?: number;
  status: string;
  conclusion: string | null;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  labels?: string[];
}

interface RawRun {
  id: number;
  path: string;
  event: string;
  head_sha: string;
  run_attempt?: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  pull_requests?: { number: number }[];
}

interface RawPull {
  number: number;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  head: { sha: string };
}

export function normalizeJob(raw: RawJob): JobFact {
  return {
    id: raw.id,
    name: raw.name,
    runAttempt: raw.run_attempt ?? 1,
    status: raw.status,
    conclusion: raw.conclusion,
    createdAt: raw.created_at ?? null,
    startedAt: raw.started_at ?? null,
    completedAt: raw.completed_at ?? null,
    labels: raw.labels ?? [],
  };
}

export function normalizeRun(raw: RawRun, jobs: readonly RawJob[]): RunFact {
  return {
    id: raw.id,
    workflowPath: raw.path,
    event: raw.event,
    headSha: raw.head_sha,
    runAttempt: raw.run_attempt ?? 1,
    status: raw.status,
    conclusion: raw.conclusion,
    createdAt: raw.created_at,
    prNumbers: (raw.pull_requests ?? []).map((pr) => pr.number),
    jobs: jobs.map(normalizeJob),
  };
}

export function normalizePr(
  raw: RawPull,
  files: readonly { filename: string }[] | null,
  classify: PathClassifier,
): PrFact {
  const names = files === null ? null : files.map((file) => file.filename);
  return {
    number: raw.number,
    state: raw.state,
    merged: raw.merged === true || Boolean(raw.merged_at),
    mergedAt: raw.merged_at ?? null,
    headSha: raw.head.sha,
    files: names,
    prType: classify(names),
  };
}

interface RawRuleset {
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[] } };
  rules?: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
}

const DEFAULT_BRANCH_REFS = new Set(["~DEFAULT_BRANCH", "~ALL", "refs/heads/main"]);

/** Required check contexts of one active ruleset that targets the default branch. */
export function requiredChecksOfRuleset(ruleset: RawRuleset): string[] {
  const includes = ruleset.conditions?.ref_name?.include ?? [];
  if (ruleset.enforcement !== "active" || !includes.some((ref) => DEFAULT_BRANCH_REFS.has(ref))) {
    return [];
  }
  return (ruleset.rules ?? [])
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    .map((check) => check.context);
}

export async function fetchRequiredChecks(api: GhApi, repo: string): Promise<string[]> {
  const list = (await api.get(`repos/${repo}/rulesets`)) as { id: number }[];
  const details = await Promise.all(
    list.map((entry) => api.get(`repos/${repo}/rulesets/${entry.id}`) as Promise<RawRuleset>),
  );
  return [...new Set(details.flatMap(requiredChecksOfRuleset))].sort();
}

/** GitHub caps a filtered run listing at 1000 results, so a busy window is split until each slice fits. */
export const RUN_LIST_RESULT_CAP = 1000;
const MIN_SLICE_MS = 60_000;

export async function listRunsInWindow(
  api: GhApi,
  repo: string,
  fromMs: number,
  toMs: number,
  prRunsOnly: boolean,
): Promise<RawRun[]> {
  const found = new Map<number, RawRun>();
  const eventFilter = prRunsOnly ? "&event=pull_request" : "";
  const iso = (value: number) => new Date(value).toISOString().replace(".000Z", "Z");

  const visit = async (from: number, to: number): Promise<void> => {
    const base = `repos/${repo}/actions/runs?created=${iso(from)}..${iso(to)}&per_page=100${eventFilter}`;
    const first = (await api.get(`${base}&page=1`)) as {
      total_count: number;
      workflow_runs: RawRun[];
    };
    if (first.total_count >= RUN_LIST_RESULT_CAP && to - from > MIN_SLICE_MS) {
      const mid = Math.floor((from + to) / 2);
      await visit(from, mid);
      await visit(mid + 1000, to);
      return;
    }
    first.workflow_runs.forEach((run) => found.set(run.id, run));
    const pages = Math.ceil(first.total_count / 100);
    for (let page = 2; page <= pages; page += 1) {
      const next = (await api.get(`${base}&page=${page}`)) as { workflow_runs: RawRun[] };
      next.workflow_runs.forEach((run) => found.set(run.id, run));
    }
  };

  await visit(fromMs, toMs);
  return [...found.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function fetchJobs(api: GhApi, repo: string, runId: number): Promise<RawJob[]> {
  const jobs: RawJob[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = (await api.get(
      `repos/${repo}/actions/runs/${runId}/jobs?filter=all&per_page=100&page=${page}`,
    )) as { total_count: number; jobs: RawJob[] };
    jobs.push(...response.jobs);
    if (jobs.length >= response.total_count || response.jobs.length === 0) {
      break;
    }
  }
  return jobs;
}

/** Runs `task` over `items` with at most `limit` in flight; the first rejection stops new work. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: unknown = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await task(items[index]);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) {
    throw failure;
  }
  return results;
}

export interface FetchOptions {
  repo: string;
  sinceMs: number;
  untilMs: number;
  prRunsOnly: boolean;
  concurrency: number;
  classify: PathClassifier;
}

async function jobsForRun(
  api: GhApi,
  cache: CacheStore,
  repo: string,
  run: RawRun,
): Promise<RawJob[]> {
  const key = `jobs-${run.id}-${run.run_attempt ?? 1}`;
  const cached = run.status === "completed" ? (cache.read(key) as RawJob[] | undefined) : undefined;
  if (cached) {
    return cached;
  }
  const jobs = await fetchJobs(api, repo, run.id);
  if (run.status === "completed") {
    cache.write(key, jobs);
  }
  return jobs;
}

async function prFact(
  api: GhApi,
  cache: CacheStore,
  options: FetchOptions,
  number: number,
): Promise<PrFact> {
  const pullKey = `pull-${number}`;
  let pull = cache.read(pullKey) as RawPull | undefined;
  if (!pull) {
    pull = (await api.get(`repos/${options.repo}/pulls/${number}`)) as RawPull;
    if (pull.state === "closed") {
      cache.write(pullKey, pull);
    }
  }
  const filesKey = `files-${number}-${pull.head.sha}`;
  let files = cache.read(filesKey) as { filename: string }[] | undefined;
  if (!files) {
    files = [];
    for (let page = 1; page <= 3; page += 1) {
      const chunk = (await api.get(
        `repos/${options.repo}/pulls/${number}/files?per_page=100&page=${page}`,
      )) as { filename: string }[];
      files.push(...chunk);
      if (chunk.length < 100) {
        break;
      }
    }
    cache.write(filesKey, files);
  }
  return normalizePr(pull, files, options.classify);
}

/**
 * A run's `pull_requests` is empty when the PR merged or closed before the run was recorded, and
 * for fork PRs. Those head SHAs are resolved through the commit's associated pull requests.
 */
async function attachPrNumbersFromCommits(
  api: GhApi,
  cache: CacheStore,
  options: FetchOptions,
  runs: RunFact[],
): Promise<void> {
  const prRuns = runs.filter((run) => run.event === "pull_request");
  const withNumbers = new Set(
    prRuns.filter((run) => run.prNumbers.length > 0).map((run) => run.headSha),
  );
  const orphanShas = [
    ...new Set(prRuns.filter((run) => !withNumbers.has(run.headSha)).map((run) => run.headSha)),
  ];
  const numbersBySha = new Map(
    await mapLimit(orphanShas, options.concurrency, async (sha): Promise<[string, number[]]> => {
      const key = `commit-pulls-${sha}`;
      let pulls = cache.read(key) as { number: number; head?: { sha: string } }[] | undefined;
      if (!pulls) {
        pulls = (await api.get(`repos/${options.repo}/commits/${sha}/pulls`)) as {
          number: number;
          head?: { sha: string };
        }[];
        if (pulls.length > 0) {
          cache.write(key, pulls);
        }
      }
      return [sha, pulls.filter((pull) => pull.head?.sha === sha).map((pull) => pull.number)];
    }),
  );
  for (const run of prRuns) {
    if (run.prNumbers.length === 0) {
      run.prNumbers = numbersBySha.get(run.headSha) ?? [];
    }
  }
}

export async function fetchBundle(
  api: GhApi,
  cache: CacheStore,
  options: FetchOptions,
  requiredChecks: string[],
): Promise<Bundle> {
  const rawRuns = await listRunsInWindow(
    api,
    options.repo,
    options.sinceMs,
    options.untilMs,
    options.prRunsOnly,
  );
  const runs = await mapLimit(rawRuns, options.concurrency, async (run) =>
    normalizeRun(run, await jobsForRun(api, cache, options.repo, run)),
  );
  await attachPrNumbersFromCommits(api, cache, options, runs);
  const prNumbers = [
    ...new Set(runs.filter((run) => run.event === "pull_request").flatMap((run) => run.prNumbers)),
  ].sort((a, b) => a - b);
  const prs = await mapLimit(prNumbers, options.concurrency, (number) =>
    prFact(api, cache, options, number),
  );
  return {
    meta: {
      repo: options.repo,
      since: new Date(options.sinceMs).toISOString(),
      until: new Date(options.untilMs).toISOString(),
      requiredChecks,
      prRunsOnly: options.prRunsOnly,
    },
    runs,
    prs,
  };
}
