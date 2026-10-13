/**
 * Read-only GitHub fetch layer for `scripts/ci/ci-time-to-green.ts` (#11582).
 *
 * Every call is a GET through the injected `GhApi`; completed-run job pages and closed PRs are
 * cached item by item through the injected `CacheStore`, so a run that stops on the API budget or a
 * rate limit resumes where it stopped.
 */
import type { Bundle, ExternalJobFact, JobFact, PrFact, RunFact } from "./ciTimeToGreenReport";
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
  runner_name?: string | null;
  steps?: { name: string; number: number; conclusion: string | null }[];
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
  head_branch?: string;
  pull_requests?: { number: number }[];
}

interface RawPull {
  number: number;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  updated_at?: string;
  head: { sha: string; ref?: string; repo?: { full_name: string } | null };
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
    runnerName: raw.runner_name ?? null,
    failedStep:
      (raw.steps ?? [])
        .filter((step) => step.conclusion === "failure" || step.conclusion === "timed_out")
        .sort((a, b) => a.number - b.number)[0]?.name ?? null,
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
  circleci?: boolean;
  circleciMainPushes?: boolean;
  circleciMacosMatcher: (name: string) => boolean;
}

async function jobsForRun(
  api: GhApi,
  cache: CacheStore,
  repo: string,
  run: RawRun,
): Promise<RawJob[]> {
  if (run.event !== "pull_request" && run.conclusion === "skipped") {
    return [];
  }
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
  listed: readonly RawPull[],
): Promise<PrFact> {
  const pullKey = `pull-${number}`;
  let pull = cache.read(pullKey) as RawPull | undefined;
  if (!pull) {
    pull =
      listed.find((item) => item.number === number) ??
      ((await api.get(`repos/${options.repo}/pulls/${number}`)) as RawPull);
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
  listed: readonly RawPull[],
): Promise<void> {
  const prRuns = runs.filter((run) => run.event === "pull_request");
  const withNumbers = new Set(
    prRuns.filter((run) => run.prNumbers.length > 0).map((run) => run.headSha),
  );
  const orphanShas = [
    ...new Set(prRuns.filter((run) => !withNumbers.has(run.headSha)).map((run) => run.headSha)),
  ];
  const resolved = await mapLimit(
    orphanShas,
    options.concurrency,
    async (sha): Promise<[string, number[]]> => {
      const key = `commit-pulls-${sha}`;
      let pulls = cache.read(key) as { number: number; head?: { sha: string } }[] | undefined;
      const matches = listedPullsForSha(sha, listed);
      if (!pulls && matches.length > 0) {
        return [sha, matches.map((pull) => pull.number)];
      }
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
    },
  );
  const numbersBySha = new Map([
    ...prRuns
      .filter((run) => run.prNumbers.length > 0)
      .map((run): [string, number[]] => [run.headSha, run.prNumbers]),
    ...resolved,
  ]);
  for (const run of prRuns) {
    if (run.prNumbers.length === 0) {
      run.prNumbers = numbersBySha.get(run.headSha) ?? [];
    }
  }
}

export async function listRecentPulls(
  api: GhApi,
  repo: string,
  sinceMs: number,
): Promise<RawPull[]> {
  const pulls: RawPull[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const chunk = (await api.get(
      `repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
    )) as RawPull[];
    pulls.push(...chunk);
    const lastUpdated = Date.parse(chunk.at(-1)?.updated_at ?? "");
    if (chunk.length < 100 || !Number.isFinite(lastUpdated) || lastUpdated < sinceMs) {
      break;
    }
  }
  return pulls;
}

function listedPullsForSha(sha: string, listed: readonly RawPull[]): RawPull[] {
  return listed.filter((pull) => pull.head.sha === sha);
}

function needsBulkPulls(runs: readonly RunFact[], cache: CacheStore): boolean {
  const prRuns = runs.filter((run) => run.event === "pull_request");
  const known = new Set(prRuns.filter((run) => run.prNumbers.length > 0).map((run) => run.headSha));
  const orphan = new Set(
    prRuns
      .filter(
        (run) => !known.has(run.headSha) && cache.read(`commit-pulls-${run.headSha}`) === undefined,
      )
      .map((run) => run.headSha),
  );
  const numbers = new Set(prRuns.flatMap((run) => run.prNumbers));
  for (const run of prRuns) {
    const cached = cache.read(`commit-pulls-${run.headSha}`) as
      | { number: number; head?: { sha: string } }[]
      | undefined;
    cached
      ?.filter((pull) => pull.head?.sha === run.headSha)
      .forEach((pull) => numbers.add(pull.number));
  }
  return (
    orphan.size +
      [...numbers].filter((number) => cache.read(`pull-${number}`) === undefined).length >=
    2
  );
}

export interface CommitStatus {
  context: string;
  state: string;
  created_at: string;
}
const CIRCLE_PREFIX = "ci/circleci:";

export function circleciStatusesCacheable(statuses: readonly CommitStatus[]): boolean {
  const newest = new Map<string, CommitStatus>();
  for (const status of statuses) {
    if (!status.context.startsWith(CIRCLE_PREFIX)) {
      continue;
    }
    const previous = newest.get(status.context);
    if (!previous || status.created_at > previous.created_at) {
      newest.set(status.context, status);
    }
  }
  return [...newest.values()].every((status) => status.state !== "pending");
}

export function normalizeCircleciStatuses(
  statuses: readonly CommitStatus[],
  sha: string,
  macos: (name: string) => boolean,
): ExternalJobFact[] {
  const jobs: ExternalJobFact[] = [];
  const open = new Map<string, ExternalJobFact[]>();
  const chronological = [...statuses].sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) ||
      Number(b.state === "pending") - Number(a.state === "pending"),
  );
  for (const status of chronological) {
    if (!status.context.startsWith(CIRCLE_PREFIX)) {
      continue;
    }
    const name = status.context.slice(CIRCLE_PREFIX.length).trim();
    if (status.state === "pending") {
      const job: ExternalJobFact = {
        provider: "circleci",
        name,
        sha,
        createdAt: status.created_at,
        completedAt: null,
        state: "pending",
        macos: macos(name),
      };
      jobs.push(job);
      open.set(name, [...(open.get(name) ?? []), job]);
    } else if (["success", "failure", "error"].includes(status.state)) {
      for (const job of open.get(name) ?? []) {
        job.completedAt = status.created_at;
        job.state = status.state;
      }
      open.delete(name);
    }
  }
  return jobs;
}

async function fetchExternalJobs(
  api: GhApi,
  cache: CacheStore,
  options: FetchOptions,
  runs: readonly RawRun[],
  prs: readonly PrFact[],
  normalized: readonly RunFact[],
): Promise<{ jobs: ExternalJobFact[]; fetched: boolean }> {
  if (options.circleci === false) {
    return { jobs: [], fetched: false };
  }
  const types = new Map(prs.map((pr) => [pr.number, pr.prType]));
  const shas = new Set(
    normalized
      .filter(
        (run) =>
          run.event === "pull_request" &&
          (run.prNumbers.length === 0 ||
            run.prNumbers.some((number) =>
              ["ios", "mixed", "unknown"].includes(types.get(number) ?? "unknown"),
            )),
      )
      .map((run) => run.headSha),
  );
  if (options.circleciMainPushes && !options.prRunsOnly) {
    runs
      .filter((run) => run.event === "push" && run.head_branch === "main")
      .forEach((run) => shas.add(run.head_sha));
  }
  const jobs = await mapLimit([...shas], options.concurrency, async (sha) => {
    const key = `statuses-${sha}`;
    let statuses = cache.read(key) as CommitStatus[] | undefined;
    if (!statuses) {
      statuses = (await api.get(
        `repos/${options.repo}/commits/${sha}/statuses?per_page=100`,
      )) as CommitStatus[];
      if (circleciStatusesCacheable(statuses)) {
        cache.write(key, statuses);
      }
    }
    return normalizeCircleciStatuses(statuses, sha, options.circleciMacosMatcher);
  });
  return { jobs: jobs.flat(), fetched: shas.size > 0 };
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
  const listed = needsBulkPulls(runs, cache)
    ? await listRecentPulls(api, options.repo, options.sinceMs)
    : [];
  await attachPrNumbersFromCommits(api, cache, options, runs, listed);
  const prNumbers = [
    ...new Set(runs.filter((run) => run.event === "pull_request").flatMap((run) => run.prNumbers)),
  ].sort((a, b) => a - b);
  const prs = await mapLimit(prNumbers, options.concurrency, (number) =>
    prFact(api, cache, options, number, listed),
  );
  const external = await fetchExternalJobs(api, cache, options, rawRuns, prs, runs);
  return {
    externalJobs: external.jobs,
    meta: {
      repo: options.repo,
      since: new Date(options.sinceMs).toISOString(),
      until: new Date(options.untilMs).toISOString(),
      requiredChecks,
      prRunsOnly: options.prRunsOnly,
      circleci: external.fetched,
      circleciScope:
        options.circleciMainPushes && !options.prRunsOnly ? "pr-heads+main-pushes" : "pr-heads",
    },
    runs,
    prs,
  };
}
