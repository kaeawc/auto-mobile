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

  read(key: string): unknown {
    return this.entries.get(key);
  }

  write(key: string, value: unknown): void {
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
