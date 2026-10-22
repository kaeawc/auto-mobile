import { parseDumpDurationMs } from "./dumpDuration";
import {
  WORK_MANAGER_JOB_SERVICE,
  type JobInfo,
  type JobSchedulerDumpParser,
} from "./BackgroundWorkTypes";

/**
 * Parses `dumpsys jobscheduler [<pkg>]` across API 29-35.
 *
 * Every job prints as `JOB #<uid>/<jobId>: <hash> <service>` followed by a more deeply indented
 * body; the same job can also appear under `Pending queue` / `Active jobs`, which only mark state.
 * Body lines are matched by label, not position, because their order and set vary by release.
 */

const JOB_LINE = /\bJOB #([^/\s]+)\/(-?\d+):\s+\S+\s+(\S+)/;
const SECTION_HEADER = /^(Registered(?: \d+)? jobs?|Pending queue|Active jobs|Ready queue)\b/i;
const NETWORK_TYPES: Readonly<Record<string, string>> = {
  "0": "none",
  "1": "any",
  "2": "unmetered",
  "3": "not-roaming",
  "4": "cellular",
};
const CONSTRAINT_NAME = /\b[A-Z][A-Z_]{2,}\b/g;

type Section = "registered" | "pending" | "active" | "other";

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function sectionOf(header: string): Section {
  const name = header.toLowerCase();
  if (name.startsWith("registered")) {
    return "registered";
  }
  if (name.startsWith("pending") || name.startsWith("ready")) {
    return "pending";
  }
  return name.startsWith("active") ? "active" : "other";
}

function userIdOf(uid: string): number {
  const user = /^u(\d+)/.exec(uid);
  return user ? Number(user[1]) : 0;
}

function constraintNames(text: string | undefined): string[] {
  return [...new Set(text?.match(CONSTRAINT_NAME) ?? [])];
}

function labelled(body: readonly string[], label: RegExp): RegExpExecArray | null {
  for (const line of body) {
    const match = label.exec(line);
    if (match) {
      return match;
    }
  }
  return null;
}

function legacyRequirements(body: readonly string[]): string[] {
  const requires = labelled(
    body,
    /Requires:\s+charging=(\w+)\s+batteryNotLow=(\w+)\s+deviceIdle=(\w+)/,
  );
  if (!requires) {
    return [];
  }
  return [
    ...(requires[1] === "true" ? ["CHARGING"] : []),
    ...(requires[2] === "true" ? ["BATTERY_NOT_LOW"] : []),
    ...(requires[3] === "true" ? ["DEVICE_IDLE"] : []),
  ];
}

function runTimes(body: readonly string[]): Pick<JobInfo, "earliestRunInMs" | "latestRunInMs"> {
  const run = labelled(body, /Run time:\s+earliest=(\S+?),\s+latest=(\S+?)(?:,|\s|$)/);
  const earliest = parseDumpDurationMs(run?.[1]);
  const latest = parseDumpDurationMs(run?.[2]);
  return {
    ...(earliest === undefined ? {} : { earliestRunInMs: earliest }),
    ...(latest === undefined ? {} : { latestRunInMs: latest }),
  };
}

function periodicity(body: readonly string[]): Pick<JobInfo, "periodic" | "intervalMs" | "flexMs"> {
  const periodic = labelled(body, /PERIODIC:\s+interval=(\S+)\s+flex=(\S+)/);
  if (!periodic) {
    return { periodic: false };
  }
  const intervalMs = parseDumpDurationMs(periodic[1]);
  const flexMs = parseDumpDurationMs(periodic[2]);
  return {
    periodic: true,
    ...(intervalMs === undefined ? {} : { intervalMs }),
    ...(flexMs === undefined ? {} : { flexMs }),
  };
}

interface JobBlock {
  uid: string;
  jobId: number;
  firstLineService: string;
  section: Section;
  body: string[];
}

function sourcePackage(block: JobBlock, service: string): string {
  const source = labelled(block.body, /Source:\s+uid=\S+\s+user=\d+\s+pkg=(\S+)/);
  return source?.[1] ?? service.split("/")[0];
}

function buildJob(block: JobBlock): { job: JobInfo; packageName: string } {
  const service = labelled(block.body, /^\s*Service:\s+(\S+)/)?.[1] ?? block.firstLineService;
  const networkType = labelled(block.body, /Network type:\s*(\d+)/)?.[1];
  const network = networkType === undefined ? undefined : NETWORK_TYPES[networkType];
  const required = labelled(block.body, /Required constraints:(.*)/)?.[1];
  const unsatisfied = labelled(block.body, /Unsatisfied constraints:(.*)/)?.[1];
  return {
    packageName: sourcePackage(block, service),
    job: {
      jobId: block.jobId,
      userId: userIdOf(block.uid),
      service,
      workManager: service.endsWith(`/${WORK_MANAGER_JOB_SERVICE}`),
      ...periodicity(block.body),
      requiredConstraints: [
        ...new Set([...legacyRequirements(block.body), ...constraintNames(required)]),
      ],
      unsatisfiedConstraints: constraintNames(unsatisfied),
      ...(network === undefined ? {} : { networkType: network }),
      ...runTimes(block.body),
    },
  };
}

function collectBlocks(lines: readonly string[]): JobBlock[] {
  const blocks: JobBlock[] = [];
  let section: Section = "other";
  let current: { block: JobBlock; indent: number } | null = null;
  for (const line of lines) {
    const indent = indentOf(line);
    if (current && line.trim() !== "" && indent <= current.indent) {
      current = null;
    }
    if (current) {
      current.block.body.push(line);
      continue;
    }
    const job = JOB_LINE.exec(line);
    if (job) {
      const block: JobBlock = {
        uid: job[1],
        jobId: Number(job[2]),
        firstLineService: job[3],
        section,
        body: [],
      };
      blocks.push(block);
      current = { block, indent };
      continue;
    }
    const header = SECTION_HEADER.exec(line.trim());
    if (header && indent <= 4) {
      section = sectionOf(header[1]);
    }
  }
  return blocks;
}

export class AospJobSchedulerDumpParser implements JobSchedulerDumpParser {
  parse(output: string, appId: string): JobInfo[] {
    const jobs = new Map<string, JobInfo>();
    const states = new Map<string, Pick<JobInfo, "pending" | "running">>();
    for (const block of collectBlocks(output.split(/\r?\n/))) {
      const { job, packageName } = buildJob(block);
      if (packageName !== appId) {
        continue;
      }
      const key = `${job.userId}/${job.jobId}`;
      const state = states.get(key) ?? {};
      if (block.section === "pending") {
        state.pending = true;
      } else if (block.section === "active") {
        state.running = true;
      }
      states.set(key, state);
      // The Registered entry carries the full body; queue entries only add state.
      if (!jobs.has(key) || block.section === "registered") {
        jobs.set(key, job);
      }
    }
    return [...jobs.entries()].map(([key, job]) => ({ ...job, ...states.get(key) }));
  }
}
