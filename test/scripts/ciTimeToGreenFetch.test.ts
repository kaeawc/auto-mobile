import {
  createCircleciMacosMatcher,
  parseCircleciMacosJobNames,
} from "../../scripts/ci/circleciMacosJobs";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BudgetedGhApi,
  FetchStoppedError,
  RUN_LIST_RESULT_CAP,
  fetchBundle,
  fetchRequiredChecks,
  listRunsInWindow,
  mapLimit,
  normalizePr,
  normalizeJob,
  normalizeCircleciStatuses,
  circleciStatusesCacheable,
  listRecentPulls,
  type CommitStatus,
  type FetchOptions,
  normalizeRun,
  requiredChecksOfRuleset,
  type CacheStore,
  type GhApi,
} from "../../scripts/ci/ciTimeToGreenFetch";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(import.meta.dir, "../fixtures/ci-time-to-green", name), "utf8"));

class FakeApi implements GhApi {
  readonly paths: string[] = [];

  constructor(private readonly routes: (path: string) => unknown) {}

  async get(path: string): Promise<unknown> {
    this.paths.push(path);
    return this.routes(path);
  }
}

class MemoryCache implements CacheStore {
  readonly entries = new Map<string, unknown>();
  readonly writes: string[] = [];

  read(key: string): unknown {
    return this.entries.get(key);
  }

  write(key: string, value: unknown): void {
    this.writes.push(key);
    this.entries.set(key, value);
  }
}

describe("required checks from the ruleset API (captured)", () => {
  test("reads the contexts of the active default-branch ruleset", () => {
    const ruleset = fixture("ruleset.json") as Parameters<typeof requiredChecksOfRuleset>[0];
    const checks = requiredChecksOfRuleset(ruleset);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks).toContain("Fast Validation");
    expect(new Set(checks).size).toBe(checks.length);
  });

  test("ignores disabled rulesets, other branches and non status-check rules", () => {
    const rule = {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "X" }] },
    };
    const include = ["~DEFAULT_BRANCH"];
    expect(
      requiredChecksOfRuleset({
        enforcement: "disabled",
        conditions: { ref_name: { include } },
        rules: [rule],
      }),
    ).toEqual([]);
    expect(
      requiredChecksOfRuleset({
        enforcement: "active",
        conditions: { ref_name: { include: ["refs/heads/dev"] } },
        rules: [rule],
      }),
    ).toEqual([]);
    expect(
      requiredChecksOfRuleset({
        enforcement: "active",
        conditions: { ref_name: { include } },
        rules: [{ type: "deletion" }],
      }),
    ).toEqual([]);
  });

  test("lists rulesets and merges the detail of each", async () => {
    const detail = fixture("ruleset.json");
    const api = new FakeApi((path) => (path.endsWith("/rulesets") ? [{ id: 7 }] : detail));
    const checks = await fetchRequiredChecks(api, "o/r");
    expect(api.paths).toEqual(["repos/o/r/rulesets", "repos/o/r/rulesets/7"]);
    expect(checks).toContain("Fast Validation");
  });
});

describe("normalizers over captured API responses", () => {
  test("normalizes a run and its jobs including labels, attempts and PR numbers", () => {
    const run = fixture("run.json") as Parameters<typeof normalizeRun>[0];
    const jobs = fixture("jobs.json") as { jobs: Parameters<typeof normalizeRun>[1] };
    const normalized = normalizeRun(run, jobs.jobs);
    expect(normalized.event).toBe("pull_request");
    expect(normalized.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(normalized.prNumbers).toEqual([]);
    expect(normalized.jobs.length).toBe(jobs.jobs.length);
    expect(normalized.jobs.every((job) => job.runAttempt >= 1)).toBe(true);
    expect(normalized.jobs.some((job) => job.labels.length > 0)).toBe(true);
  });

  test("classifies a pull request from its captured changed files", () => {
    const pull = fixture("pull.json") as Parameters<typeof normalizePr>[0];
    const files = fixture("pull-files.json") as { filename: string }[];
    const pr = normalizePr(pull, files, () => "ts-only");
    expect(pr.files).toEqual(files.map((file) => file.filename));
    expect(pr.headSha).toBe(pull.head.sha);
    expect(pr.prType).toBe("ts-only");
  });
});

describe("listRunsInWindow", () => {
  const makeRuns = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: from + index,
      created_at: new Date(1_000_000 + (from + index) * 1000).toISOString(),
    }));

  test("splits a window whose listing hits GitHub's result cap and dedupes the overlap", async () => {
    const api = new FakeApi((path) => {
      const range = /created=([^.]+)\.\.([^&]+)/.exec(path);
      const wide = range && Date.parse(range[2]) - Date.parse(range[1]) > 3_600_000;
      if (wide) {
        return { total_count: RUN_LIST_RESULT_CAP, workflow_runs: makeRuns(0, 100) };
      }
      return { total_count: 2, workflow_runs: makeRuns(5, 2) };
    });
    const runs = await listRunsInWindow(api, "o/r", 0, 4 * 3_600_000, false);
    expect(runs.map((run) => run.id)).toEqual([5, 6]);
    expect(api.paths.length).toBeGreaterThan(2);
  });

  test("pages through a listing that fits and adds the event filter on request", async () => {
    const api = new FakeApi((path) => {
      const page = Number(/[?&]page=(\d+)/.exec(path)?.[1]);
      return { total_count: 150, workflow_runs: makeRuns(page * 1000, page === 1 ? 100 : 50) };
    });
    const runs = await listRunsInWindow(api, "o/r", 0, 3_600_000, true);
    expect(runs).toHaveLength(150);
    expect(api.paths.every((path) => path.includes("&event=pull_request"))).toBe(true);
  });
});

describe("fetchBundle caching and API budget", () => {
  const rawRun = (id: number, status: string) => ({
    id,
    path: ".github/workflows/pull_request.yml",
    event: "pull_request",
    head_sha: `sha${id}`,
    run_attempt: 1,
    status,
    conclusion: status === "completed" ? "success" : null,
    created_at: "2026-10-10T10:00:00Z",
    pull_requests: [],
  });
  const routes = (path: string): unknown => {
    if (path.includes("/actions/runs?")) {
      return { total_count: 2, workflow_runs: [rawRun(1, "completed"), rawRun(2, "in_progress")] };
    }
    if (path.includes("/jobs?")) {
      return {
        total_count: 1,
        jobs: [
          {
            id: 9,
            name: "Lint",
            status: "completed",
            conclusion: "success",
            labels: ["ubuntu-latest"],
          },
        ],
      };
    }
    if (path.includes("/pulls?")) {
      return [];
    }
    if (path.includes("/commits/")) {
      return [{ number: 5, head: { sha: "sha2" } }];
    }
    if (path.includes("/files")) {
      return [{ filename: "src/a.ts" }];
    }
    return {
      number: 5,
      state: "closed",
      merged: true,
      merged_at: "2026-10-10T11:00:00Z",
      head: { sha: "sha2" },
    };
  };
  const options = {
    repo: "o/r",
    sinceMs: 0,
    untilMs: 3_600_000,
    prRunsOnly: false,
    concurrency: 2,
    classify: () => "ts-only" as const,
    circleci: false,
    circleciMacosMatcher: () => false,
  };

  test("a second fetch reuses completed-run jobs and closed PRs but refetches in-flight runs", async () => {
    const cache = new MemoryCache();
    const first = new FakeApi(routes);
    await fetchBundle(first, cache, options, ["Lint"]);
    const second = new FakeApi(routes);
    const bundle = await fetchBundle(second, cache, options, ["Lint"]);
    const jobCalls = second.paths.filter((path) => path.includes("/jobs?"));
    expect(jobCalls).toHaveLength(1);
    expect(jobCalls[0]).toContain("/runs/2/jobs");
    expect(second.paths.some((path) => path.includes("/pulls/5"))).toBe(false);
    expect(bundle.prs[0]).toMatchObject({ number: 5, merged: true, prType: "ts-only" });
    const attached = bundle.runs.map((run) => run.prNumbers);
    expect(attached).toEqual([[], [5]]);
  });

  test("stops with a typed error when the call budget is exhausted and keeps what it cached", async () => {
    const cache = new MemoryCache();
    const api = new BudgetedGhApi(new FakeApi(routes), 2);
    await expect(fetchBundle(api, cache, options, ["Lint"])).rejects.toBeInstanceOf(
      FetchStoppedError,
    );
    expect(api.calls).toBe(2);
    expect(cache.entries.has("jobs-1-1")).toBe(true);
  });
});

describe("mapLimit", () => {
  test("never exceeds the concurrency limit and keeps result order", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return value * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

const capturedRun = fixture("run.json") as Parameters<typeof normalizeRun>[0];
const capturedJobs = fixture("jobs-with-steps.json") as {
  jobs: Parameters<typeof normalizeJob>[0][];
};
const capturedPulls = fixture("pulls-list.json") as Parameters<typeof normalizePr>[0][];
const capturedFiles = fixture("pull-files.json");
const capturedStatuses = fixture("commit-statuses.json") as CommitStatus[];
const circleMatch = createCircleciMacosMatcher(
  parseCircleciMacosJobNames(
    readFileSync(resolve(import.meta.dir, "../../.circleci/continue_config.yml"), "utf8"),
  ),
);
const fetchOptions: FetchOptions = {
  repo: "o/r",
  sinceMs: 0,
  untilMs: Date.parse("2026-10-14T00:00:00Z"),
  prRunsOnly: false,
  concurrency: 2,
  classify: () => "ios",
  circleciMacosMatcher: circleMatch,
};

function capturedApi(
  runs: (typeof capturedRun)[],
  pulls = capturedPulls,
  statuses = capturedStatuses,
): FakeApi {
  return new FakeApi((path) => {
    if (path.includes("/actions/runs?")) {
      return { total_count: runs.length, workflow_runs: runs };
    }
    if (path.includes("/jobs?")) {
      return fixture("jobs-with-steps.json");
    }
    if (path.includes("/statuses?")) {
      return statuses;
    }
    if (path.includes("/commits/") && path.endsWith("/pulls")) {
      return capturedPulls;
    }
    if (path.includes("/pulls?")) {
      return pulls;
    }
    if (path.includes("/files?")) {
      return capturedFiles;
    }
    const number = Number(path.split("/").at(-1));
    const pull = capturedPulls.find((item) => item.number === number);
    if (!pull) {
      throw new Error(`Unexpected fake API path: ${path}`);
    }
    return pull;
  });
}

function prRun(index: number): typeof capturedRun {
  return {
    ...capturedRun,
    id: capturedRun.id + index,
    head_sha: capturedPulls[index].head.sha,
    pull_requests: [],
    head_branch: capturedPulls[index].head.ref,
  };
}

test("captured jobs preserve runners and the first failed step", () => {
  const jobs = capturedJobs.jobs.map(normalizeJob);
  expect(jobs.map((job) => job.runnerName)).toEqual(
    capturedJobs.jobs.map((job) => job.runner_name ?? null),
  );
  expect(
    jobs
      .filter((job) => job.conclusion === "failure")
      .map((job) => job.failedStep)
      .sort(),
  ).toEqual(["Run complete unit lane", "Run complete unit lane", "Run fast validation checks"]);
  const failed = capturedJobs.jobs.find((job) =>
    job.steps?.some((step) => step.conclusion === "failure"),
  )!;
  expect(normalizeJob({ ...failed, steps: [...failed.steps!].reverse() }).failedStep).toBe(
    normalizeJob(failed).failedStep,
  );
});

test("skips jobs only for skipped non-PR runs", async () => {
  const runs = [
    { ...prRun(0), event: "push", conclusion: "skipped" },
    { ...prRun(1), conclusion: "skipped" },
  ];
  const api = capturedApi(runs);
  const result = await fetchBundle(
    api,
    new MemoryCache(),
    { ...fetchOptions, circleci: false },
    [],
  );
  expect(result.runs[0].jobs).toEqual([]);
  expect(result.runs[1].jobs).toHaveLength(capturedJobs.jobs.length);
  expect(api.paths.filter((path) => path.includes("/jobs?"))).toHaveLength(1);
});

test("bulk list resolves exact SHAs, serves facts and caches closed pulls", async () => {
  const runs = [prRun(0), prRun(1)];
  const api = capturedApi(runs);
  const cache = new MemoryCache();
  const result = await fetchBundle(api, cache, fetchOptions, []);
  expect(result.runs.map((run) => run.prNumbers)).toEqual([[12126], [12124]]);
  expect(result.prs.every((pr) => pr.merged)).toBe(true);
  expect(api.paths.filter((path) => path.includes("/pulls?"))).toHaveLength(1);
  expect(api.paths.filter((path) => /\/pulls\/\d+$/.test(path))).toEqual([]);
  expect(api.paths.filter((path) => path.endsWith("/pulls"))).toEqual([]);
  expect(cache.entries.has("pull-12126")).toBe(true);
  expect(api.paths.filter((path) => path.includes("/files?"))).toHaveLength(2);
});

test("a branch-only listing match stays unresolved and falls back to commit pulls", async () => {
  const runs = [prRun(0), { ...prRun(1), head_sha: "older-branch-head" }];
  const api = capturedApi(runs);
  const result = await fetchBundle(
    api,
    new MemoryCache(),
    { ...fetchOptions, circleci: false },
    [],
  );
  expect(result.runs.map((run) => run.prNumbers)).toEqual([[12126], []]);
  expect(api.paths).toContain("repos/o/r/commits/older-branch-head/pulls");
  expect(api.paths.filter((path) => path.endsWith("/pulls"))).toHaveLength(1);
});

test("bulk threshold counts uncached pulls and orphan SHAs, with caches avoiding listing", async () => {
  const api = capturedApi([prRun(0)]);
  const cache = new MemoryCache();
  await fetchBundle(api, cache, { ...fetchOptions, circleci: false }, []);
  expect(api.paths.some((path) => path.includes("/pulls?"))).toBe(false);
  const second = capturedApi([prRun(0), { ...prRun(1), pull_requests: [{ number: 12124 }] }]);
  await fetchBundle(second, cache, { ...fetchOptions, circleci: false }, []);
  expect(second.paths.some((path) => path.includes("/pulls?"))).toBe(false);
  const uncached = capturedApi([{ ...prRun(0), pull_requests: [{ number: 12126 }] }, prRun(1)]);
  await fetchBundle(uncached, new MemoryCache(), { ...fetchOptions, circleci: false }, []);
  expect(uncached.paths.filter((path) => path.includes("/pulls?"))).toHaveLength(1);
});

test("bulk pages stop on old updates, short pages, or the ten-page cap", async () => {
  const page = Array.from({ length: 100 }, (_, i) => capturedPulls[i % capturedPulls.length]);
  const old = new FakeApi(() => page);
  expect(await listRecentPulls(old, "o/r", Date.parse("2026-10-14T00:00:00Z"))).toHaveLength(100);
  expect(old.paths).toHaveLength(1);
  const capped = new FakeApi(() => page);
  expect(await listRecentPulls(capped, "o/r", 0)).toHaveLength(1000);
  expect(capped.paths).toHaveLength(10);
  const short = new FakeApi(() => capturedPulls);
  expect(await listRecentPulls(short, "o/r", 0)).toHaveLength(4);
  expect(short.paths).toHaveLength(1);
});

test("captured CircleCI statuses form one macOS and one non-macOS interval", () => {
  const jobs = normalizeCircleciStatuses(capturedStatuses, "fa9fd355", circleMatch);
  expect(jobs.filter((job) => job.macos)).toEqual([
    {
      provider: "circleci",
      name: "Build Xcode Projects (main)",
      sha: "fa9fd355",
      createdAt: "2026-10-13T01:27:38Z",
      completedAt: "2026-10-13T01:32:55Z",
      state: "success",
      macos: true,
    },
  ]);
  expect(jobs.filter((job) => !job.macos)).toHaveLength(1);
  expect(jobs.find((job) => !job.macos)?.name).toBe("detect-main-macos-changes");
});

test("CircleCI reruns open separate intervals; terminal without pending is ignored", () => {
  const pending = capturedStatuses.find(
    (status) => status.context.includes("Build Xcode") && status.state === "pending",
  )!;
  const terminal = capturedStatuses[0];
  const events = [
    ...capturedStatuses,
    { ...pending, created_at: "2026-10-13T02:00:00Z" },
    { ...terminal, state: "error", created_at: "2026-10-13T02:05:00Z" },
  ];
  expect(
    normalizeCircleciStatuses(events, "sha", circleMatch).filter((job) => job.macos),
  ).toHaveLength(2);
  expect(normalizeCircleciStatuses([terminal], "sha", circleMatch)).toEqual([]);
  expect(circleciStatusesCacheable(events)).toBe(true);
  expect(
    circleciStatusesCacheable([...events, { ...pending, created_at: "2026-10-13T03:00:00Z" }]),
  ).toBe(false);
});

test("statuses cache only terminal newest contexts and no-circleci skips all status calls", async () => {
  const cache = new MemoryCache();
  const runs = [prRun(0), { ...prRun(1), event: "push", head_branch: "main" }];
  const api = capturedApi(runs);
  const result = await fetchBundle(api, cache, fetchOptions, []);
  expect(result.meta.circleci).toBe(true);
  expect(result.externalJobs).toHaveLength(2);
  expect(api.paths.filter((path) => path.includes("/statuses?"))).toHaveLength(1);
  const second = capturedApi(runs);
  await fetchBundle(second, cache, fetchOptions, []);
  expect(second.paths.some((path) => path.includes("/statuses?"))).toBe(false);
  const pendingOnly = capturedStatuses.filter((status) => status.state === "pending");
  const pendingCache = new MemoryCache();
  await fetchBundle(
    capturedApi([prRun(0)], capturedPulls, pendingOnly),
    pendingCache,
    fetchOptions,
    [],
  );
  expect(pendingCache.entries.has(`statuses-${prRun(0).head_sha}`)).toBe(false);
  const disabled = capturedApi(runs);
  const skipped = await fetchBundle(
    disabled,
    new MemoryCache(),
    { ...fetchOptions, circleci: false },
    [],
  );
  expect(disabled.paths.some((path) => path.includes("/statuses?"))).toBe(false);
  expect(skipped.meta.circleci).toBe(false);
});

test("status selection excludes TS PRs and non-main pushes, dedupes SHA, honors PR-only", async () => {
  const runs = [
    prRun(0),
    { ...prRun(0), id: capturedRun.id + 20 },
    { ...prRun(1), event: "push", head_branch: "main" },
    { ...prRun(2), event: "push", head_branch: "feature" },
  ];
  const api = capturedApi(runs);
  await fetchBundle(
    api,
    new MemoryCache(),
    { ...fetchOptions, circleciMainPushes: true, prRunsOnly: true },
    [],
  );
  expect(api.paths.filter((path) => path.includes("/statuses?"))).toHaveLength(1);
  const ts = capturedApi(runs);
  await fetchBundle(
    ts,
    new MemoryCache(),
    { ...fetchOptions, circleciMainPushes: true, classify: () => "ts-only" },
    [],
  );
  expect(ts.paths.filter((path) => path.includes("/statuses?"))).toEqual([
    `repos/o/r/commits/${runs[2].head_sha}/statuses?per_page=100`,
  ]);
});

test("same-SHA runs reuse an attached PR number without an orphan lookup", async () => {
  const runs = [
    { ...prRun(0), pull_requests: [{ number: 12126 }] },
    { ...prRun(0), id: capturedRun.id + 30 },
  ];
  const api = capturedApi(runs);
  const result = await fetchBundle(
    api,
    new MemoryCache(),
    { ...fetchOptions, circleci: false },
    [],
  );
  expect(result.runs.map((run) => run.prNumbers)).toEqual([[12126], [12126]]);
  expect(api.paths.some((path) => path.endsWith("/pulls"))).toBe(false);
});

test("CircleCI metadata is false when no eligible statuses were requested", async () => {
  const api = capturedApi([{ ...prRun(0), event: "push", head_branch: "feature" }]);
  const result = await fetchBundle(api, new MemoryCache(), fetchOptions, []);
  expect(result.meta.circleci).toBe(false);
  expect(result.externalJobs).toEqual([]);
});

test("each pending opens an interval closed by the next terminal", () => {
  const pending = capturedStatuses.find(
    (status) => status.context.includes("Build Xcode") && status.state === "pending",
  )!;
  const terminal = capturedStatuses[0];
  const jobs = normalizeCircleciStatuses(
    [terminal, pending, { ...pending, created_at: "2026-10-13T01:28:00Z" }],
    "sha",
    circleMatch,
  );
  expect(jobs).toHaveLength(2);
  expect(jobs.every((job) => job.completedAt === terminal.created_at)).toBe(true);
});

test("closed pull cache hits do not write pull facts again", async () => {
  const cache = new MemoryCache();
  await fetchBundle(
    capturedApi([prRun(0), prRun(1)]),
    cache,
    { ...fetchOptions, circleci: false },
    [],
  );
  expect(cache.writes.filter((key) => key.startsWith("pull-")).sort()).toEqual([
    "pull-12124",
    "pull-12126",
  ]);
  cache.writes.length = 0;
  await fetchBundle(
    capturedApi([prRun(0), prRun(1)]),
    cache,
    { ...fetchOptions, circleci: false },
    [],
  );
  expect(cache.writes.filter((key) => key.startsWith("pull-"))).toEqual([]);
});

test("CircleCI main pushes are excluded by default and fetched only on opt-in", async () => {
  const runs = [prRun(0), { ...prRun(1), event: "push", head_branch: "main" }];
  const defaults = capturedApi(runs);
  const result = await fetchBundle(defaults, new MemoryCache(), fetchOptions, []);
  expect(defaults.paths.filter((path) => path.includes("/statuses?"))).toEqual([
    `repos/o/r/commits/${runs[0].head_sha}/statuses?per_page=100`,
  ]);
  expect(result.meta.circleciScope).toBe("pr-heads");
  const opted = capturedApi(runs);
  const expanded = await fetchBundle(
    opted,
    new MemoryCache(),
    { ...fetchOptions, circleciMainPushes: true },
    [],
  );
  expect(opted.paths.filter((path) => path.includes("/statuses?"))).toHaveLength(2);
  expect(expanded.meta.circleciScope).toBe("pr-heads+main-pushes");
});

test("equal-time newest-first success and pending close a zero-length interval", () => {
  const terminal = capturedStatuses[0];
  const pending = { ...terminal, state: "pending" };
  expect(normalizeCircleciStatuses([terminal, pending], "sha", circleMatch)).toEqual([
    {
      provider: "circleci",
      name: "Build Xcode Projects (main)",
      sha: "sha",
      createdAt: terminal.created_at,
      completedAt: terminal.created_at,
      state: "success",
      macos: true,
    },
  ]);
});

test("bulk paging stops when the last update is missing or unparseable", async () => {
  for (const updated_at of [undefined, "invalid"]) {
    const page = Array.from({ length: 100 }, () => ({ ...capturedPulls[0], updated_at }));
    const api = new FakeApi(() => page);
    expect(await listRecentPulls(api, "o/r", 0)).toHaveLength(100);
    expect(api.paths).toHaveLength(1);
  }
});
