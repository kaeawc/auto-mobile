import { describe, expect, test } from "bun:test";
import {
  buildReport,
  computeShaRecords,
  peakConcurrency,
  percentile,
  renderMarkdown,
  runnerPool,
  type Bundle,
  type JobFact,
  type PrFact,
  type RunFact,
} from "../../scripts/ci/ciTimeToGreenReport";

let nextId = 1;
const T0 = Date.parse("2026-10-10T10:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function job(name: string, overrides: Partial<JobFact> = {}): JobFact {
  return {
    id: nextId++,
    name,
    runAttempt: 1,
    status: "completed",
    conclusion: "success",
    createdAt: at(0),
    startedAt: at(0),
    completedAt: at(5),
    labels: ["ubuntu-latest"],
    runnerName: null,
    failedStep: null,
    ...overrides,
  };
}

function run(
  sha: string,
  startMin: number,
  jobs: JobFact[],
  overrides: Partial<RunFact> = {},
): RunFact {
  return {
    id: nextId++,
    workflowPath: ".github/workflows/pull_request.yml",
    event: "pull_request",
    headSha: sha,
    runAttempt: 1,
    status: "completed",
    conclusion: "success",
    createdAt: at(startMin),
    prNumbers: [1],
    jobs,
    ...overrides,
  };
}

function pr(overrides: Partial<PrFact> = {}): PrFact {
  return {
    number: 1,
    state: "open",
    merged: false,
    mergedAt: null,
    headSha: "a",
    files: ["src/a.ts"],
    prType: "ts-only",
    ...overrides,
  };
}

function bundle(runs: RunFact[], prs: PrFact[], required = ["Lint", "Test"]): Bundle {
  return {
    meta: {
      repo: "o/r",
      since: at(-60),
      until: at(600),
      requiredChecks: required,
      prRunsOnly: false,
    },
    runs,
    prs,
  };
}

describe("percentile", () => {
  test("uses nearest rank and returns null when empty", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10, 30, 20, 40], 50)).toBe(20);
    expect(percentile([10, 30, 20, 40], 90)).toBe(40);
    expect(percentile([7], 90)).toBe(7);
  });
});

describe("computeShaRecords", () => {
  test("green time is the moment the last required check first succeeded", () => {
    const records = computeShaRecords(
      bundle(
        [
          run("a", 0, [
            job("Lint", { completedAt: at(4) }),
            job("Test", { completedAt: at(12) }),
            job("Not required", { completedAt: at(30) }),
          ]),
        ],
        [pr()],
      ),
    );
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe("green");
    expect(records[0].greenAt).toBe(T0 + 12 * 60_000);
    expect(records[0].criticalCheck).toBe("Test");
    expect(records[0].firstAttemptPass).toBe(true);
  });

  test("a skipped required check is green at its skip time", () => {
    const [record] = computeShaRecords(
      bundle(
        [
          run("a", 0, [
            job("Lint", { completedAt: at(3) }),
            job("Test", { conclusion: "skipped", completedAt: at(1), labels: [] }),
          ]),
        ],
        [pr()],
      ),
    );
    expect(record.outcome).toBe("green");
    expect(record.checkGreenOffsetMs.get("Test")).toBe(60_000);
  });

  test("a re-run that finally passes is green but not a first-attempt pass", () => {
    const [record] = computeShaRecords(
      bundle(
        [
          run(
            "a",
            0,
            [
              job("Lint"),
              job("Test", { conclusion: "failure", runAttempt: 1, completedAt: at(6) }),
              job("Test", { runAttempt: 2, completedAt: at(20) }),
            ],
            { runAttempt: 2 },
          ),
        ],
        [pr()],
      ),
    );
    expect(record.outcome).toBe("green");
    expect(record.greenAt).toBe(T0 + 20 * 60_000);
    expect(record.firstAttemptPass).toBe(false);
  });

  test("an unfinished SHA followed by a newer push is superseded, a failed one is not", () => {
    const records = computeShaRecords(
      bundle(
        [
          run("cancelled", 0, [job("Lint"), job("Test", { conclusion: "cancelled" })]),
          run("failed", 10, [job("Lint"), job("Test", { conclusion: "failure" })]),
          run("latest", 20, [job("Lint"), job("Test")]),
        ],
        [pr({ headSha: "latest" })],
      ),
    );
    const outcomes = Object.fromEntries(records.map((record) => [record.sha, record.outcome]));
    expect(outcomes).toEqual({ cancelled: "superseded", failed: "not-green", latest: "green" });
  });

  test("a merged head that never went green is merged-before-green; one that greened after merge too", () => {
    const records = computeShaRecords(
      bundle(
        [
          run("never", 0, [job("Lint"), job("Test", { conclusion: "failure" })], {
            prNumbers: [1],
          }),
          run("late", 0, [job("Lint"), job("Test", { completedAt: at(50) })], { prNumbers: [2] }),
        ],
        [
          pr({ number: 1, headSha: "never", merged: true, mergedAt: at(10) }),
          pr({ number: 2, headSha: "late", merged: true, mergedAt: at(20) }),
        ],
      ),
    );
    expect(records.map((record) => record.outcome)).toEqual([
      "merged-before-green",
      "merged-before-green",
    ]);
  });

  test("a SHA with a missing required job is not green, and an in-flight one is pending", () => {
    const records = computeShaRecords(
      bundle(
        [
          run("missing", 0, [job("Lint")]),
          run(
            "flying",
            0,
            [job("Lint"), job("Test", { status: "in_progress", conclusion: null })],
            {
              status: "in_progress",
              conclusion: null,
              prNumbers: [2],
            },
          ),
        ],
        [pr({ headSha: "missing" }), pr({ number: 2, headSha: "flying" })],
      ),
    );
    expect(records.map((record) => record.outcome)).toEqual(["not-green", "pending"]);
  });

  test("ignores non pull_request runs", () => {
    expect(
      computeShaRecords(bundle([run("m", 0, [job("Lint"), job("Test")], { event: "push" })], [])),
    ).toEqual([]);
  });
});

describe("peakConcurrency", () => {
  test("touching intervals do not overlap", () => {
    expect(
      peakConcurrency([
        { start: 0, end: 10 },
        { start: 10, end: 20 },
      ]).peak,
    ).toBe(1);
  });

  test("counts simultaneous intervals and reports when the peak began", () => {
    const result = peakConcurrency([
      { start: 0, end: 30 },
      { start: 5, end: 25 },
      { start: 8, end: 12 },
    ]);
    expect(result).toEqual({ peak: 3, peakAtMs: 8 });
  });
});

describe("runnerPool", () => {
  test("separates self-hosted Mac, Namespace and GitHub-hosted labels", () => {
    expect(runnerPool(["self-hosted", "automobile-mac"])).toBe("self-hosted-mac");
    expect(runnerPool(["namespace-profile-auto-mobile"])).toBe("namespace");
    expect(runnerPool(["ubuntu-latest"])).toBe("github-hosted");
  });
});

describe("buildReport", () => {
  const runs = [
    run("a", 0, [
      job("Lint", { completedAt: at(4) }),
      job("Test", {
        completedAt: at(10),
        labels: ["self-hosted", "automobile-mac"],
        createdAt: at(1),
        startedAt: at(4),
      }),
    ]),
    run("b", 100, [job("Lint", { completedAt: at(103) }), job("Test", { completedAt: at(130) })], {
      prNumbers: [2],
    }),
    run("c", 100, [job("Lint"), job("Test", { conclusion: "failure" })], { prNumbers: [3] }),
  ];
  const prs = [
    pr({ number: 1, headSha: "a" }),
    pr({ number: 2, headSha: "b", prType: "android" }),
    pr({ number: 3, headSha: "c", prType: "android" }),
  ];

  test("aggregates time to green, first-attempt pass rate and failing checks by PR type", () => {
    const report = buildReport(bundle(runs, prs));
    expect(report.counts).toMatchObject({ shas: 3, green: 2, notGreen: 1 });
    expect(report.timeToGreenMs.p50).toBe(10 * 60_000);
    expect(report.timeToGreenMs.max).toBe(30 * 60_000);
    expect(report.byType["ts-only"].timeToGreenMs.p50).toBe(10 * 60_000);
    expect(report.byType.android.slowestRequired).toEqual({
      check: "Test",
      p50Ms: 30 * 60_000,
      criticalShare: 1,
    });
    expect(report.firstAttempt).toMatchObject({ eligible: 3, passed: 2 });
    expect(report.firstAttempt.topFailingChecks).toEqual([
      { check: "Test", executed: 3, firstAttemptFailures: 1, rate: 1 / 3 },
    ]);
    expect(report.perPrTimeToGreenMs).toMatchObject({ n: 2, prsNeverGreen: 1 });
  });

  test("filters by PR type but keeps concurrency across everything", () => {
    const report = buildReport(bundle(runs, prs), "android");
    expect(report.counts.shas).toBe(2);
    expect(report.concurrency.selfHostedMac.peak).toBe(1);
    expect(report.concurrency.selfHostedMac.cap).toBe(3);
    expect(report.concurrency.githubHosted.cap).toBe(40);
  });

  test("reports queue time per runner label set", () => {
    const report = buildReport(bundle(runs, prs));
    const mac = report.queueTime.find((row) => row.labels === "self-hosted,automobile-mac");
    expect(mac).toMatchObject({ n: 1, p50Ms: 3 * 60_000 });
  });

  test("renders Markdown with the headline tables", () => {
    const text = renderMarkdown(buildReport(bundle(runs, prs)));
    expect(text).toContain("## Time to green");
    expect(text).toContain("| ts-only |");
    expect(text).toContain("## Peak runner concurrency");
  });
});

test("attempt rows include never-executed checks, durations, queues and exclude skips/reruns", () => {
  const jobs = [
    job("Lint", { startedAt: at(2), completedAt: at(6) }),
    job("Lint", { conclusion: "failure", startedAt: at(1), completedAt: at(11) }),
    job("Test", { conclusion: "skipped" }),
    job("Lint", { runAttempt: 2 }),
  ];
  const source = bundle(
    [run("a", 0, jobs), run("a", 0, [job("Lint")], { event: "push" })],
    [pr()],
    ["Lint", "Test", "Never"],
  );
  const report = buildReport(source);
  expect(report.firstAttempt.byCheck).toEqual([
    {
      check: "Lint",
      executed: 2,
      firstAttemptFailures: 1,
      passRate: 0.5,
      durationMs: { p50: 4 * 60000, p90: 10 * 60000 },
      queueMs: { p50: 60000 },
    },
    {
      check: "Never",
      executed: 0,
      firstAttemptFailures: 0,
      passRate: null,
      durationMs: { p50: null, p90: null },
      queueMs: { p50: null },
    },
    {
      check: "Test",
      executed: 0,
      firstAttemptFailures: 0,
      passRate: null,
      durationMs: { p50: null, p90: null },
      queueMs: { p50: null },
    },
  ]);
  expect(renderMarkdown(report)).toContain("## Required checks on attempt 1");
  expect(renderMarkdown(report)).toContain("queue p50 min");
});

test("failing step pairs include advisory jobs and sort by count, job, step", () => {
  const failed = (name: string, failedStep: string | null = null) =>
    job(name, { conclusion: "failure", failedStep });
  const source = bundle(
    [
      run("a", 0, [
        failed("Z", "same"),
        failed("Z", "same"),
        failed("Test", "z"),
        failed("Test", "a"),
        failed("Advisory"),
        job("Ignored", { conclusion: "failure", runAttempt: 2 }),
      ]),
    ],
    [pr()],
  );
  expect(buildReport(source).firstAttempt.topFailingSteps).toEqual([
    { job: "Z", step: "same", failures: 2, required: false },
    { job: "Advisory", step: "(no failed step recorded)", failures: 1, required: false },
    { job: "Test", step: "a", failures: 1, required: true },
    { job: "Test", step: "z", failures: 1, required: true },
  ]);
});

test("weighted Namespace peak is clipped, unknown profiles are a lower bound, overrides merge", () => {
  const namespace = (profile: string, start: number, end: number) =>
    job("Lint", { labels: [profile], startedAt: at(start), completedAt: at(end) });
  const source = bundle(
    [
      run("a", 0, [
        namespace("namespace-profile-auto-mobile", 0, 10),
        namespace("namespace-profile-auto-mobile-small", 5, 12),
        namespace("namespace-profile-auto-mobile-macos", 10, 20),
        namespace("namespace-future", 6, 8),
        namespace("namespace-profile-auto-mobile", 700, 800),
      ]),
    ],
    [pr()],
    ["Lint"],
  );
  const report = buildReport(source);
  expect(report.concurrency.namespace).toMatchObject({ peak: 3, jobs: 4, cap: null });
  expect(report.concurrency.namespaceVcpu).toEqual({
    peak: 8,
    peakAt: at(10),
    cap: 32,
    unknownProfiles: ["namespace-future"],
  });
  expect(report.concurrency.namespaceProfiles).toEqual([
    { profile: "namespace-future", vcpu: null, peakJobs: 1, jobs: 1 },
    { profile: "namespace-profile-auto-mobile", vcpu: 4, peakJobs: 1, jobs: 1 },
    { profile: "namespace-profile-auto-mobile-macos", vcpu: 6, peakJobs: 1, jobs: 1 },
    { profile: "namespace-profile-auto-mobile-small", vcpu: 2, peakJobs: 1, jobs: 1 },
  ]);
  expect(renderMarkdown(report)).toContain("lower bound: unknown profile namespace-future");
  const overridden = buildReport(source, null, { namespaceVcpus: { "namespace-future": 40 } });
  expect(overridden.concurrency.namespaceVcpu.peak).toBe(46);
  expect(overridden.concurrency.namespaceVcpu.unknownProfiles).toEqual([]);
  expect(renderMarkdown(overridden)).toContain("46 (OVER CAP)");
});

test("CircleCI overlapping queued/running macOS intervals exceed the one-job cap", () => {
  const source = bundle([], []);
  source.meta.circleci = true;
  source.meta.prRunsOnly = true;
  source.externalJobs = [
    {
      provider: "circleci",
      name: "A",
      sha: "a",
      createdAt: at(-100),
      completedAt: at(10),
      state: "success",
      macos: true,
    },
    {
      provider: "circleci",
      name: "B",
      sha: "b",
      createdAt: at(5),
      completedAt: null,
      state: "pending",
      macos: true,
    },
    {
      provider: "circleci",
      name: "Linux",
      sha: "c",
      createdAt: at(0),
      completedAt: at(15),
      state: "success",
      macos: false,
    },
  ];
  const report = buildReport(source);
  expect(report.concurrency.circleciMacos).toEqual({
    peak: 2,
    peakAt: at(5),
    cap: 1,
    jobs: 2,
    fetched: true,
  });
  const text = renderMarkdown(report);
  expect(text).toContain("2 (OVER CAP)");
  expect(text).toContain("nightly pipeline not visible");
  expect(text).toContain(
    "Only pull_request runs were fetched, so peaks understate total demand against the caps.",
  );
});

test("old bundles omit runners, steps and external jobs; Mac names are sorted and distinct", () => {
  const source = bundle(
    [run("a", 0, [job("Lint", { labels: ["self-hosted", "mac"] })])],
    [pr()],
    ["Lint"],
  );
  const legacy = JSON.parse(
    JSON.stringify(source, (key, value) =>
      ["runnerName", "failedStep"].includes(key) ? undefined : value,
    ),
  ) as Bundle;
  const old = buildReport(legacy);
  expect(old.concurrency.selfHostedMac.runners).toEqual([]);
  expect(old.concurrency.circleciMacos).toEqual({
    peak: 0,
    peakAt: null,
    cap: 1,
    jobs: 0,
    fetched: false,
  });
  expect(renderMarkdown(old)).toContain(
    "| circleci macos (queued or running) | - | 1 | - | - | not fetched |",
  );
  source.runs[0].jobs.push(
    ...["z", "a", "z"].map((runnerName) =>
      job("Lint", { labels: ["self-hosted", "mac"], runnerName }),
    ),
  );
  expect(buildReport(source).concurrency.selfHostedMac.runners).toEqual(["a", "z"]);
});

test("Mac job peaks never claim a machine-cap breach and exclude blank runner names", () => {
  const runners = ["mac", "mac-2", "mac-3", "mac-4", "mac-heavy"];
  const jobs = [...runners, "", "   ", "mac"].map((runnerName) =>
    job("Lint", {
      runnerName,
      labels: ["self-hosted", "mac"],
    }),
  );
  const report = buildReport(bundle([run("a", 0, jobs)], [pr()], ["Lint"]));
  expect(report.concurrency.selfHostedMac).toMatchObject({
    cap: 3,
    capUnit: "machines",
    peak: 8,
    runners,
  });
  const row = renderMarkdown(report)
    .split("\n")
    .find((line) => line.startsWith("| self-hosted mac"))!;
  expect(row).toContain("| 8 | 3 machines |");
  expect(row).toContain("5 runner processes: mac, mac-2, mac-3, mac-4, mac-heavy");
  expect(row).not.toContain("OVER CAP");
});

test("CircleCI notes describe the requested scope", () => {
  const source = bundle([], []);
  source.meta.circleci = true;
  source.meta.circleciScope = "pr-heads";
  expect(renderMarkdown(buildReport(source))).toContain(
    "from commit statuses of iOS/mixed/unknown PR heads; nightly pipeline not visible",
  );
  source.meta.circleciScope = "pr-heads+main-pushes";
  expect(renderMarkdown(buildReport(source))).toContain(
    "from commit statuses of iOS/mixed/unknown PR heads and main pushes; nightly pipeline not visible",
  );
});
