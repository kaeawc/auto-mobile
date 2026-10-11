/** Argument parsing for `scripts/ci/ci-time-to-green.ts` (#11582). */
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PR_TYPES, type PrType } from "./prPathClassification";

export const EXIT_OK = 0;
export const EXIT_UNEXPECTED = 1;
export const EXIT_USAGE = 2;
export const EXIT_API = 3;
export const EXIT_STOPPED = 4;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface CliOptions {
  help: boolean;
  repo: string | null;
  sinceMs: number;
  untilMs: number;
  prType: PrType | null;
  json: boolean;
  cacheDir: string | null;
  maxApiCalls: number;
  concurrency: number;
  prRunsOnly: boolean;
  fromBundle: string | null;
  saveBundle: string | null;
  workflowFile: string | null;
}

export const USAGE = `Usage: bun scripts/ci/ci-time-to-green.ts [options]

Reports PR time-to-green, first-attempt pass rate and peak runner concurrency for a window.
Read-only: GET requests through \`gh api\` only.

  --since WHEN         Window start: ISO timestamp or Nd / Nh before --until (default: 7d)
  --until WHEN         Window end: ISO timestamp (default: now)
  --pr-type TYPE       Only PRs of one type: ${PR_TYPES.join(" | ")}
  --json               Emit JSON instead of Markdown
  --repo OWNER/REPO    Repository (default: gh's current repository)
  --cache-dir DIR      Resumable cache; must be under the repo's scratch/ or the system temp dir
  --max-api-calls N    Stop (exit 4) after N API calls; rerun with the same --cache-dir (default: 4000)
  --concurrency N      Parallel API calls (default: 6)
  --pr-runs-only       Skip non-pull_request runs; concurrency then covers PR runs only
  --from-bundle PATH   Aggregate a saved bundle; no network access
  --save-bundle PATH   Write the fetched bundle (under scratch/ or the system temp dir)
  --workflow-file PATH pull_request.yml to read path filters from (default: the checkout's)
  -h, --help           Show this help

Exit codes: 0 ok, 1 unexpected failure, 2 usage error, 3 GitHub API failure,
            4 stopped on the call budget or a rate limit (cache kept; rerun to resume)
`;

const DURATION = /^(\d+)([dh])$/;

export function parseWhen(value: string, nowMs: number, anchorMs: number): number {
  const match = DURATION.exec(value);
  if (match) {
    const unitMs = match[2] === "d" ? 86_400_000 : 3_600_000;
    return anchorMs - Number(match[1]) * unitMs;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new UsageError(`cannot parse time "${value}": use an ISO timestamp or Nd / Nh`);
  }
  if (parsed > nowMs) {
    throw new UsageError(`time "${value}" is in the future`);
  }
  return parsed;
}

function positiveInt(name: string, value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new UsageError(`${name} expects a positive integer, got "${value}"`);
  }
  return Number(value);
}

/** Cache and bundle output may only live under <repoRoot>/scratch or the system temp directory. */
export function assertSafeOutputPath(path: string, repoRoot: string, tmpDir: string): string {
  const resolved = resolve(path);
  const inside = (root: string) => {
    const rel = relative(resolve(root), resolved);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  if (!inside(resolve(repoRoot, "scratch")) && !inside(tmpDir)) {
    throw new UsageError(`${path} is outside the repo's scratch/ and the system temp directory`);
  }
  return resolved;
}

export function parseCliArgs(
  argv: readonly string[],
  nowMs: number,
  repoRoot: string,
  tmpDir: string,
): CliOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        since: { type: "string" },
        until: { type: "string" },
        "pr-type": { type: "string" },
        json: { type: "boolean" },
        repo: { type: "string" },
        "cache-dir": { type: "string" },
        "max-api-calls": { type: "string" },
        concurrency: { type: "string" },
        "pr-runs-only": { type: "boolean" },
        "from-bundle": { type: "string" },
        "save-bundle": { type: "string" },
        "workflow-file": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const untilMs = values.until === undefined ? nowMs : parseWhen(values.until, nowMs, nowMs);
  const sinceMs = parseWhen(values.since ?? "7d", nowMs, untilMs);
  if (sinceMs >= untilMs) {
    throw new UsageError("--since must be earlier than --until");
  }
  const prType = values["pr-type"];
  if (prType !== undefined && !(PR_TYPES as readonly string[]).includes(prType)) {
    throw new UsageError(`--pr-type must be one of: ${PR_TYPES.join(", ")}`);
  }
  if (values["from-bundle"] !== undefined && values["save-bundle"] !== undefined) {
    throw new UsageError("--from-bundle and --save-bundle are mutually exclusive");
  }
  const cacheDir = values["cache-dir"];
  const saveBundle = values["save-bundle"];
  return {
    help: values.help === true,
    repo: values.repo ?? null,
    sinceMs,
    untilMs,
    prType: (prType as PrType | undefined) ?? null,
    json: values.json === true,
    cacheDir: cacheDir === undefined ? null : assertSafeOutputPath(cacheDir, repoRoot, tmpDir),
    maxApiCalls: positiveInt("--max-api-calls", values["max-api-calls"] ?? "4000"),
    concurrency: positiveInt("--concurrency", values.concurrency ?? "6"),
    prRunsOnly: values["pr-runs-only"] === true,
    fromBundle: values["from-bundle"] ?? null,
    saveBundle:
      saveBundle === undefined ? null : assertSafeOutputPath(saveBundle, repoRoot, tmpDir),
    workflowFile: values["workflow-file"] ?? null,
  };
}
