/**
 * Pure aggregation for `scripts/ci/ci-time-to-green.ts` (#11582, tracking #11585).
 *
 * Input is a normalized Bundle (runs + jobs + PR facts + the required-check list read from the
 * ruleset at run time). Nothing here touches the network, the clock or the file system.
 */
import { PR_TYPES, type PrType } from "./prPathClassification";

export interface JobFact {
  id: number;
  name: string;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  labels: string[];
  runnerName: string | null;
  failedStep: string | null;
}

export interface RunFact {
  id: number;
  workflowPath: string;
  event: string;
  headSha: string;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  createdAt: string;
  prNumbers: number[];
  jobs: JobFact[];
}

export interface PrFact {
  number: number;
  state: string;
  merged: boolean;
  mergedAt: string | null;
  headSha: string;
  /** null when the file list was not fetched. */
  files: string[] | null;
  prType: PrType;
}

export interface ExternalJobFact {
  provider: "circleci";
  name: string;
  sha: string;
  createdAt: string;
  completedAt: string | null;
  state: string;
  macos: boolean;
}

export interface Bundle {
  externalJobs?: ExternalJobFact[];
  meta: {
    repo: string;
    since: string;
    until: string;
    requiredChecks: string[];
    prRunsOnly: boolean;
    circleci?: boolean;
    circleciScope?: "pr-heads" | "pr-heads+main-pushes";
  };
  runs: RunFact[];
  prs: PrFact[];
}

export const HOSTED_CAP = 40;
export const SELF_HOSTED_MAC_CAP = 3;
export const NAMESPACE_VCPU_CAP = 32;
export const CIRCLECI_MACOS_CAP = 1;
export const DEFAULT_NAMESPACE_VCPUS: Record<string, number> = {
  "namespace-profile-auto-mobile": 4,
  "namespace-profile-auto-mobile-small": 2,
  "namespace-profile-auto-mobile-macos": 6,
};

export interface ReportOptions {
  namespaceVcpus?: Record<string, number>;
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);
const GREEN = new Set(["success", "skipped"]);

export type ShaOutcome = "green" | "merged-before-green" | "superseded" | "pending" | "not-green";

export interface ShaRecord {
  sha: string;
  prNumber: number | null;
  prType: PrType;
  startAt: number;
  greenAt: number | null;
  outcome: ShaOutcome;
  firstAttemptPass: boolean;
  /** required check name -> ms since push at which it first succeeded or was skipped. */
  checkGreenOffsetMs: Map<string, number>;
  /** required check that turned green last (the critical path), when green. */
  criticalCheck: string | null;
}

export interface Stats {
  n: number;
  p50: number | null;
  p90: number | null;
  max: number | null;
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) {
    return null;
  }
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

/** Nearest-rank percentile of an unsorted sample; null for an empty one. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function stats(values: readonly number[]): Stats {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p90: percentile(values, 90),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

/** When a job counts as having finished: a skipped job may carry no completed_at. */
function jobFinishedAt(job: JobFact, run: RunFact): number | null {
  return ms(job.completedAt) ?? ms(job.startedAt) ?? ms(job.createdAt) ?? ms(run.createdAt);
}

interface ShaGroup {
  sha: string;
  runs: RunFact[];
  prNumber: number | null;
}

function groupBySha(runs: readonly RunFact[]): ShaGroup[] {
  const groups = new Map<string, ShaGroup>();
  for (const run of runs) {
    if (run.event !== "pull_request") {
      continue;
    }
    const group = groups.get(run.headSha) ?? { sha: run.headSha, runs: [], prNumber: null };
    group.runs.push(run);
    group.prNumber ??= run.prNumbers[0] ?? null;
    groups.set(run.headSha, group);
  }
  return [...groups.values()];
}

function requiredGreen(group: ShaGroup, check: string): { at: number; attempt: number } | null {
  let best: { at: number; attempt: number } | null = null;
  for (const run of group.runs) {
    for (const job of run.jobs) {
      if (job.name !== check || !job.conclusion || !GREEN.has(job.conclusion)) {
        continue;
      }
      const at = jobFinishedAt(job, run);
      if (at !== null && (best === null || at < best.at)) {
        best = { at, attempt: job.runAttempt };
      }
    }
  }
  return best;
}

function hasRequiredFailure(group: ShaGroup, required: ReadonlySet<string>): boolean {
  return group.runs.some((run) =>
    run.jobs.some((job) => required.has(job.name) && job.conclusion && FAILED.has(job.conclusion)),
  );
}

export function computeShaRecords(bundle: Bundle): ShaRecord[] {
  const required = new Set(bundle.meta.requiredChecks);
  const prByNumber = new Map(bundle.prs.map((pr) => [pr.number, pr]));
  const groups = groupBySha(bundle.runs);

  const startByGroup = new Map(
    groups.map((group) => [
      group,
      Math.min(...group.runs.map((run) => ms(run.createdAt) ?? Infinity)),
    ]),
  );
  const latestStartByPr = new Map<number, number>();
  for (const group of groups) {
    if (group.prNumber !== null) {
      const start = startByGroup.get(group) ?? 0;
      latestStartByPr.set(
        group.prNumber,
        Math.max(latestStartByPr.get(group.prNumber) ?? 0, start),
      );
    }
  }

  return groups.map((group) => {
    const startAt = startByGroup.get(group) ?? 0;
    const pr = group.prNumber === null ? undefined : prByNumber.get(group.prNumber);
    const offsets = new Map<string, number>();
    let allGreen = bundle.meta.requiredChecks.length > 0;
    let greenAt = 0;
    let criticalCheck: string | null = null;
    let allOnFirstAttempt = true;
    for (const check of bundle.meta.requiredChecks) {
      const green = requiredGreen(group, check);
      if (green === null) {
        allGreen = false;
        continue;
      }
      offsets.set(check, green.at - startAt);
      if (green.at >= greenAt) {
        greenAt = green.at;
        criticalCheck = check;
      }
      if (green.attempt !== 1) {
        allOnFirstAttempt = false;
      }
    }
    const reran = group.runs.some((run) => run.runAttempt > 1);
    const mergedAt = ms(pr?.mergedAt);
    const mergedThisSha = pr?.merged === true && pr.headSha === group.sha;
    const hasLaterSha =
      group.prNumber !== null && (latestStartByPr.get(group.prNumber) ?? 0) > startAt;
    const finished = group.runs.every((run) => run.status === "completed");

    let outcome: ShaOutcome;
    if (allGreen && !(mergedThisSha && mergedAt !== null && greenAt > mergedAt)) {
      outcome = "green";
    } else if (mergedThisSha) {
      outcome = "merged-before-green";
    } else if (hasLaterSha && !hasRequiredFailure(group, required)) {
      outcome = "superseded";
    } else if (!allGreen && !finished && !hasRequiredFailure(group, required)) {
      outcome = "pending";
    } else {
      outcome = "not-green";
    }
    return {
      sha: group.sha,
      prNumber: group.prNumber,
      prType: pr?.prType ?? "unknown",
      startAt,
      greenAt: allGreen ? greenAt : null,
      outcome,
      firstAttemptPass: outcome === "green" && allOnFirstAttempt && !reran,
      checkGreenOffsetMs: offsets,
      criticalCheck: allGreen ? criticalCheck : null,
    };
  });
}

export interface CheckFailureRate {
  check: string;
  executed: number;
  firstAttemptFailures: number;
  rate: number;
}

export interface CheckAttemptRow {
  check: string;
  executed: number;
  firstAttemptFailures: number;
  passRate: number | null;
  durationMs: { p50: number | null; p90: number | null };
  queueMs: { p50: number | null };
}
export interface FailingStepRow {
  job: string;
  step: string;
  failures: number;
  required: boolean;
}

export interface TypeBreakdown {
  shas: number;
  green: number;
  timeToGreenMs: Stats;
  firstAttemptPass: { eligible: number; passed: number; rate: number | null };
  slowestRequired: { check: string; p50Ms: number; criticalShare: number } | null;
}

export interface ConcurrencyPool {
  peak: number;
  peakAt: string | null;
  cap: number | null;
  jobs: number;
}

export interface QueueRow {
  labels: string;
  n: number;
  p50Ms: number | null;
  p90Ms: number | null;
  maxMs: number | null;
}

export interface Report {
  window: { since: string; until: string };
  requiredChecks: string[];
  prTypeFilter: PrType | null;
  counts: {
    shas: number;
    green: number;
    mergedBeforeGreen: number;
    superseded: number;
    notGreen: number;
    pending: number;
  };
  timeToGreenMs: Stats;
  perPrTimeToGreenMs: Stats & { prsNeverGreen: number };
  byType: Record<string, TypeBreakdown>;
  firstAttempt: {
    eligible: number;
    passed: number;
    rate: number | null;
    topFailingChecks: CheckFailureRate[];
    byCheck: CheckAttemptRow[];
    topFailingSteps: FailingStepRow[];
  };
  requiredChecksMissing: { check: string; shasWithoutJob: number }[];
  concurrency: {
    prRunsOnly: boolean;
    overall: ConcurrencyPool;
    githubHosted: ConcurrencyPool;
    namespace: ConcurrencyPool;
    selfHostedMac: ConcurrencyPool & { runners: string[]; capUnit: "machines" };
    namespaceVcpu: { peak: number; peakAt: string | null; cap: 32; unknownProfiles: string[] };
    namespaceProfiles: { profile: string; vcpu: number | null; peakJobs: number; jobs: number }[];
    circleciMacos: ConcurrencyPool & { fetched: boolean; scope?: Bundle["meta"]["circleciScope"] };
  };
  queueTime: QueueRow[];
}

function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function breakdown(records: readonly ShaRecord[]): TypeBreakdown {
  const green = records.filter((record) => record.outcome === "green");
  const eligible = records.filter(
    (record) =>
      record.outcome === "green" ||
      record.outcome === "not-green" ||
      record.outcome === "merged-before-green",
  );
  const passed = eligible.filter((record) => record.firstAttemptPass).length;
  const byCheck = new Map<string, number[]>();
  const critical = new Map<string, number>();
  for (const record of green) {
    for (const [check, offset] of record.checkGreenOffsetMs) {
      byCheck.set(check, [...(byCheck.get(check) ?? []), offset]);
    }
    if (record.criticalCheck) {
      critical.set(record.criticalCheck, (critical.get(record.criticalCheck) ?? 0) + 1);
    }
  }
  let slowest: TypeBreakdown["slowestRequired"] = null;
  for (const [check, offsets] of byCheck) {
    const p50 = percentile(offsets, 50) ?? 0;
    if (slowest === null || p50 > slowest.p50Ms) {
      slowest = { check, p50Ms: p50, criticalShare: (critical.get(check) ?? 0) / green.length };
    }
  }
  return {
    shas: records.length,
    green: green.length,
    timeToGreenMs: stats(
      green.map((record) => (record.greenAt ?? record.startAt) - record.startAt),
    ),
    firstAttemptPass: { eligible: eligible.length, passed, rate: rate(passed, eligible.length) },
    slowestRequired: slowest,
  };
}

function attemptJobs(bundle: Bundle, includedShas: ReadonlySet<string>): JobFact[] {
  return bundle.runs
    .filter((run) => run.event === "pull_request" && includedShas.has(run.headSha))
    .flatMap((run) => run.jobs)
    .filter((job) => job.runAttempt === 1);
}

function elapsed(start: string | null, end: string | null): number[] {
  const from = ms(start);
  const to = ms(end);
  return from === null || to === null || to < from ? [] : [to - from];
}

function checkAttempts(bundle: Bundle, jobs: readonly JobFact[]): CheckAttemptRow[] {
  return bundle.meta.requiredChecks
    .map((check) => {
      const executed = jobs.filter(
        (job) =>
          job.name === check &&
          job.conclusion &&
          (job.conclusion === "success" || FAILED.has(job.conclusion)),
      );
      const failures = executed.filter((job) => FAILED.has(job.conclusion ?? "")).length;
      const durations = executed.flatMap((job) => elapsed(job.startedAt, job.completedAt));
      const queues = executed.flatMap((job) => elapsed(job.createdAt, job.startedAt));
      return {
        check,
        executed: executed.length,
        firstAttemptFailures: failures,
        passRate: rate(executed.length - failures, executed.length),
        durationMs: { p50: percentile(durations, 50), p90: percentile(durations, 90) },
        queueMs: { p50: percentile(queues, 50) },
      };
    })
    .sort(
      (a, b) => b.firstAttemptFailures - a.firstAttemptFailures || a.check.localeCompare(b.check),
    );
}

function failingSteps(jobs: readonly JobFact[], required: readonly string[]): FailingStepRow[] {
  const rows = new Map<string, FailingStepRow>();
  for (const job of jobs) {
    if (!FAILED.has(job.conclusion ?? "")) {
      continue;
    }
    const step = job.failedStep ?? "(no failed step recorded)";
    const key = JSON.stringify([job.name, step]);
    const row = rows.get(key) ?? {
      job: job.name,
      step,
      failures: 0,
      required: required.includes(job.name),
    };
    row.failures += 1;
    rows.set(key, row);
  }
  return [...rows.values()]
    .sort(
      (a, b) =>
        b.failures - a.failures || a.job.localeCompare(b.job) || a.step.localeCompare(b.step),
    )
    .slice(0, 10);
}

interface Interval {
  start: number;
  end: number;
  weight?: number;
}

/** Peak simultaneous intervals; an interval ending at t does not overlap one starting at t. */
export function peakConcurrency(intervals: readonly Interval[]): {
  peak: number;
  peakAtMs: number | null;
} {
  const events = intervals.flatMap((interval) => [
    { at: interval.start, delta: interval.weight ?? 1 },
    { at: interval.end, delta: -(interval.weight ?? 1) },
  ]);
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let peak = 0;
  let peakAtMs: number | null = null;
  for (const event of events) {
    current += event.delta;
    if (current > peak) {
      peak = current;
      peakAtMs = event.at;
    }
  }
  return { peak, peakAtMs };
}

function pool(intervals: readonly Interval[], cap: number | null): ConcurrencyPool {
  const { peak, peakAtMs } = peakConcurrency(intervals);
  return {
    peak,
    peakAt: peakAtMs === null ? null : new Date(peakAtMs).toISOString(),
    cap,
    jobs: intervals.length,
  };
}

export type RunnerPool = "github-hosted" | "namespace" | "self-hosted-mac" | "self-hosted-other";

export function runnerPool(labels: readonly string[]): RunnerPool {
  if (labels.some((label) => label.startsWith("namespace-"))) {
    return "namespace";
  }
  if (labels.includes("self-hosted")) {
    return labels.some((label) => /mac/i.test(label)) ? "self-hosted-mac" : "self-hosted-other";
  }
  return "github-hosted";
}

function runnerIntervals(bundle: Bundle) {
  const windowStart = ms(bundle.meta.since) ?? 0;
  const windowEnd = ms(bundle.meta.until) ?? 0;
  const rows: {
    pool: RunnerPool;
    interval: Interval;
    labels: string;
    queueMs: number | null;
    profile: string | null;
  }[] = [];
  for (const run of bundle.runs) {
    for (const job of run.jobs) {
      const started = ms(job.startedAt);
      if (job.labels.length === 0 || started === null || job.conclusion === "skipped") {
        continue;
      }
      const ended = ms(job.completedAt) ?? windowEnd;
      const created = ms(job.createdAt);
      rows.push({
        pool: runnerPool(job.labels),
        profile: job.labels.find((label) => label.startsWith("namespace-")) ?? null,
        interval: {
          start: Math.max(started, windowStart),
          end: Math.min(Math.max(ended, started), windowEnd),
        },
        labels: job.labels.join(","),
        queueMs: created === null ? null : Math.max(0, started - created),
      });
    }
  }
  return rows.filter((row) => row.interval.end > row.interval.start);
}

function namespaceConcurrency(
  rows: ReturnType<typeof runnerIntervals>,
  options: ReportOptions,
): Pick<Report["concurrency"], "namespaceVcpu" | "namespaceProfiles"> {
  const vcpus = { ...DEFAULT_NAMESPACE_VCPUS, ...options.namespaceVcpus };
  const namespace = rows.filter((row) => row.pool === "namespace");
  const profiles = [
    ...new Set(namespace.flatMap((row) => (row.profile === null ? [] : [row.profile]))),
  ].sort();
  const weighted = pool(
    namespace.map((row) => ({ ...row.interval, weight: vcpus[row.profile ?? ""] ?? 0 })),
    NAMESPACE_VCPU_CAP,
  );
  return {
    namespaceVcpu: {
      peak: weighted.peak,
      peakAt: weighted.peakAt,
      cap: NAMESPACE_VCPU_CAP,
      unknownProfiles: profiles.filter((profile) => vcpus[profile] === undefined),
    },
    namespaceProfiles: profiles.map((profile) => {
      const intervals = namespace
        .filter((row) => row.profile === profile)
        .map((row) => row.interval);
      return {
        profile,
        vcpu: vcpus[profile] ?? null,
        peakJobs: pool(intervals, null).peak,
        jobs: intervals.length,
      };
    }),
  };
}

function circleciIntervals(bundle: Bundle): Interval[] {
  const start = ms(bundle.meta.since) ?? 0;
  const end = ms(bundle.meta.until) ?? 0;
  return (bundle.externalJobs ?? [])
    .filter((job) => job.macos)
    .map((job) => ({
      start: Math.max(ms(job.createdAt) ?? end, start),
      end: Math.min(ms(job.completedAt) ?? end, end),
    }))
    .filter((interval) => interval.end > interval.start);
}

function concurrencyReport(
  bundle: Bundle,
  options: ReportOptions,
): Report["concurrency"] & { queue: QueueRow[] } {
  const rows = runnerIntervals(bundle);
  const namespace = namespaceConcurrency(rows, options);
  const of = (names: readonly RunnerPool[]) =>
    rows.filter((row) => names.includes(row.pool)).map((row) => row.interval);
  const queues = new Map<string, number[]>();
  for (const row of rows) {
    if (row.queueMs !== null) {
      queues.set(row.labels, [...(queues.get(row.labels) ?? []), row.queueMs]);
    }
  }
  return {
    prRunsOnly: bundle.meta.prRunsOnly,
    overall: pool(
      rows.map((row) => row.interval),
      null,
    ),
    githubHosted: pool(of(["github-hosted"]), HOSTED_CAP),
    namespace: pool(of(["namespace"]), null),
    selfHostedMac: {
      ...pool(of(["self-hosted-mac"]), SELF_HOSTED_MAC_CAP),
      capUnit: "machines",
      runners: [
        ...new Set(
          bundle.runs
            .flatMap((run) => run.jobs)
            .filter((job) => runnerPool(job.labels) === "self-hosted-mac")
            .flatMap((job) => {
              const name = job.runnerName?.trim();
              return name ? [name] : [];
            }),
        ),
      ].sort(),
    },
    ...namespace,
    circleciMacos: {
      ...pool(circleciIntervals(bundle), CIRCLECI_MACOS_CAP),
      fetched: bundle.meta.circleci === true,
      ...(bundle.meta.circleciScope ? { scope: bundle.meta.circleciScope } : {}),
    },
    queue: [...queues]
      .map(([labels, values]) => ({
        labels,
        n: values.length,
        p50Ms: percentile(values, 50),
        p90Ms: percentile(values, 90),
        maxMs: Math.max(...values),
      }))
      .sort((a, b) => (b.p90Ms ?? 0) - (a.p90Ms ?? 0) || a.labels.localeCompare(b.labels)),
  };
}

export function buildReport(
  bundle: Bundle,
  prTypeFilter: PrType | null = null,
  options: ReportOptions = {},
): Report {
  const all = computeShaRecords(bundle);
  const records = prTypeFilter ? all.filter((record) => record.prType === prTypeFilter) : all;
  const count = (outcome: ShaOutcome) =>
    records.filter((record) => record.outcome === outcome).length;
  const green = records.filter((record) => record.outcome === "green");

  const prStart = new Map<number, number>();
  const prFirstGreen = new Map<number, number>();
  for (const record of records) {
    if (record.prNumber === null) {
      continue;
    }
    prStart.set(
      record.prNumber,
      Math.min(prStart.get(record.prNumber) ?? Infinity, record.startAt),
    );
    if (record.greenAt !== null) {
      prFirstGreen.set(
        record.prNumber,
        Math.min(prFirstGreen.get(record.prNumber) ?? Infinity, record.greenAt),
      );
    }
  }
  const perPr = [...prFirstGreen].map(([pr, at]) => at - (prStart.get(pr) ?? at));

  const eligible = records.filter((record) =>
    ["green", "not-green", "merged-before-green"].includes(record.outcome),
  );
  const eligibleShas = new Set(eligible.map((record) => record.sha));
  const passed = eligible.filter((record) => record.firstAttemptPass).length;

  const byType: Record<string, TypeBreakdown> = {};
  for (const type of PR_TYPES) {
    const subset = records.filter((record) => record.prType === type);
    if (subset.length > 0) {
      byType[type] = breakdown(subset);
    }
  }

  const jobNamesBySha = new Map<string, Set<string>>();
  for (const run of bundle.runs) {
    const names = jobNamesBySha.get(run.headSha) ?? new Set<string>();
    run.jobs.forEach((job) => names.add(job.name));
    jobNamesBySha.set(run.headSha, names);
  }
  const missing = bundle.meta.requiredChecks
    .map((check) => ({
      check,
      shasWithoutJob: eligible.filter((record) => !jobNamesBySha.get(record.sha)?.has(check))
        .length,
    }))
    .filter((row) => row.shasWithoutJob > 0);

  const { queue, ...concurrency } = concurrencyReport(bundle, options);
  const jobs = attemptJobs(bundle, eligibleShas);
  const byCheck = checkAttempts(bundle, jobs);
  return {
    window: { since: bundle.meta.since, until: bundle.meta.until },
    requiredChecks: bundle.meta.requiredChecks,
    prTypeFilter,
    counts: {
      shas: records.length,
      green: green.length,
      mergedBeforeGreen: count("merged-before-green"),
      superseded: count("superseded"),
      notGreen: count("not-green"),
      pending: count("pending"),
    },
    timeToGreenMs: stats(
      green.map((record) => (record.greenAt ?? record.startAt) - record.startAt),
    ),
    perPrTimeToGreenMs: {
      ...stats(perPr),
      prsNeverGreen: [...prStart.keys()].filter((pr) => !prFirstGreen.has(pr)).length,
    },
    byType,
    firstAttempt: {
      eligible: eligible.length,
      passed,
      rate: rate(passed, eligible.length),
      byCheck,
      topFailingSteps: failingSteps(jobs, bundle.meta.requiredChecks),
      topFailingChecks: byCheck
        .filter((row) => row.firstAttemptFailures > 0)
        .slice(0, 15)
        .map((row) => ({
          check: row.check,
          executed: row.executed,
          firstAttemptFailures: row.firstAttemptFailures,
          rate: row.firstAttemptFailures / row.executed,
        })),
    },
    requiredChecksMissing: missing,
    concurrency,
    queueTime: queue,
  };
}

function minutes(value: number | null): string {
  return value === null ? "-" : `${(value / 60000).toFixed(1)}`;
}

function percent(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(0)}%`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (row) =>
        `| ${row.map((cell) => cell.replaceAll("|", "\\|").replaceAll("\n", " ")).join(" | ")} |`,
    ),
  ];
}

function poolRow(name: string, pool: ConcurrencyPool, note = ""): string[] {
  const cap = pool.cap === null ? "-" : `${pool.cap}`;
  const over = pool.cap !== null && pool.peak > pool.cap ? " (OVER CAP)" : "";
  return [name, `${pool.peak}${over}`, cap, pool.peakAt ?? "-", `${pool.jobs}`, note];
}

function concurrencyRows(concurrency: Report["concurrency"]): string[][] {
  const vcpu = concurrency.namespaceVcpu;
  const circle = concurrency.circleciMacos;
  const note = vcpu.unknownProfiles.length
    ? `lower bound: unknown profile ${vcpu.unknownProfiles.join(", ")}`
    : "";
  return [
    poolRow("all runners", concurrency.overall),
    poolRow("github-hosted (jobs)", concurrency.githubHosted),
    [
      "self-hosted mac (jobs)",
      `${concurrency.selfHostedMac.peak}`,
      `${concurrency.selfHostedMac.cap} machines`,
      concurrency.selfHostedMac.peakAt ?? "-",
      `${concurrency.selfHostedMac.jobs}`,
      `${concurrency.selfHostedMac.runners.length} runner processes: ${concurrency.selfHostedMac.runners.join(", ")}`,
    ],
    poolRow("namespace (jobs)", concurrency.namespace),
    poolRow("namespace (vCPU)", { ...vcpu, jobs: concurrency.namespace.jobs }, note),
    ...concurrency.namespaceProfiles.map((row) =>
      poolRow(`${row.profile} (${row.vcpu ?? "unknown"} vCPU each)`, {
        peak: row.peakJobs,
        peakAt: null,
        cap: null,
        jobs: row.jobs,
      }),
    ),
    circle.fetched
      ? poolRow(
          "circleci macos (queued or running)",
          circle,
          `from commit statuses of iOS/mixed/unknown PR heads${circle.scope === "pr-heads+main-pushes" ? " and main pushes" : ""}; nightly pipeline not visible`,
        )
      : ["circleci macos (queued or running)", "-", `${circle.cap}`, "-", "-", "not fetched"],
  ];
}

export function renderMarkdown(report: Report): string {
  const lines: string[] = [
    `# CI time-to-green report`,
    ``,
    `Window: ${report.window.since} .. ${report.window.until}` +
      (report.prTypeFilter ? ` (PR type: ${report.prTypeFilter})` : ""),
    `Required checks (from the ruleset): ${report.requiredChecks.length}`,
    ``,
    `## PR head SHAs`,
    ``,
    ...table(
      ["green", "merged before green", "superseded (excluded)", "not green", "pending", "total"],
      [
        [
          `${report.counts.green}`,
          `${report.counts.mergedBeforeGreen}`,
          `${report.counts.superseded}`,
          `${report.counts.notGreen}`,
          `${report.counts.pending}`,
          `${report.counts.shas}`,
        ],
      ],
    ),
    ``,
    `## Time to green (minutes, push to every required check green)`,
    ``,
    ...table(
      [
        "PR type",
        "SHAs",
        "green",
        "p50",
        "p90",
        "max",
        "first-attempt pass",
        "slowest required check (p50 min, critical share)",
      ],
      [
        ...Object.entries(report.byType).map(([type, row]) => [
          type,
          `${row.shas}`,
          `${row.green}`,
          minutes(row.timeToGreenMs.p50),
          minutes(row.timeToGreenMs.p90),
          minutes(row.timeToGreenMs.max),
          `${row.firstAttemptPass.passed}/${row.firstAttemptPass.eligible} (${percent(row.firstAttemptPass.rate)})`,
          row.slowestRequired
            ? `${row.slowestRequired.check} (${minutes(row.slowestRequired.p50Ms)}, ${percent(row.slowestRequired.criticalShare)})`
            : "-",
        ]),
        [
          "**all**",
          `${report.counts.shas}`,
          `${report.counts.green}`,
          minutes(report.timeToGreenMs.p50),
          minutes(report.timeToGreenMs.p90),
          minutes(report.timeToGreenMs.max),
          `${report.firstAttempt.passed}/${report.firstAttempt.eligible} (${percent(report.firstAttempt.rate)})`,
          "-",
        ],
      ],
    ),
    ``,
    `Per PR (first push to first green SHA): n=${report.perPrTimeToGreenMs.n}, p50 ${minutes(report.perPrTimeToGreenMs.p50)}, p90 ${minutes(report.perPrTimeToGreenMs.p90)}, max ${minutes(report.perPrTimeToGreenMs.max)} min; ${report.perPrTimeToGreenMs.prsNeverGreen} PRs never reached green in the window.`,
    ``,
    `## Required checks on attempt 1`,
    ``,
    ...table(
      ["check", "runs", "failures", "pass rate", "p50 min", "p90 min", "queue p50 min"],
      report.firstAttempt.byCheck.map((row) => [
        row.check,
        `${row.executed}`,
        `${row.firstAttemptFailures}`,
        percent(row.passRate),
        minutes(row.durationMs.p50),
        minutes(row.durationMs.p90),
        minutes(row.queueMs.p50),
      ]),
    ),
    ``,
    `## Top failing job/step pairs on attempt 1`,
    ``,
    ...table(
      ["job", "step", "failures", "required"],
      report.firstAttempt.topFailingSteps.map((row) => [
        row.job,
        row.step,
        `${row.failures}`,
        `${row.required}`,
      ]),
    ),
    ``,
    `## Peak runner concurrency${report.concurrency.prRunsOnly ? " (pull_request runs only)" : " (all workflows)"}`,
    ``,
    ...table(
      ["pool", "peak", "cap", "peak at (UTC)", "jobs", "note"],
      concurrencyRows(report.concurrency),
    ),
    ...(report.concurrency.prRunsOnly
      ? [
          "",
          "Only pull_request runs were fetched, so peaks understate total demand against the caps.",
        ]
      : []),
    ``,
    `## Queue time (created to started, minutes)`,
    ``,
    ...table(
      ["runner labels", "jobs", "p50", "p90", "max"],
      report.queueTime.map((row) => [
        row.labels,
        `${row.n}`,
        minutes(row.p50Ms),
        minutes(row.p90Ms),
        minutes(row.maxMs),
      ]),
    ),
  ];
  if (report.requiredChecksMissing.length > 0) {
    lines.push(
      ``,
      `## Required checks with no matching job (name drift or never scheduled)`,
      ``,
      ...table(
        ["check", "SHAs with no job of this name"],
        report.requiredChecksMissing.map((row) => [row.check, `${row.shasWithoutJob}`]),
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}
