/**
 * PR time-to-green, first-attempt pass rate and peak runner concurrency (#11582, tracking #11585).
 *
 * Fetch layer: scripts/ci/ciTimeToGreenFetch.ts. Aggregation: scripts/ci/ciTimeToGreenReport.ts.
 * Read-only: only `gh api` GET requests. Run with `--help` for flags and exit codes.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  EXIT_API,
  EXIT_OK,
  EXIT_STOPPED,
  EXIT_UNEXPECTED,
  EXIT_USAGE,
  USAGE,
  UsageError,
  parseCliArgs,
  type CliOptions,
} from "./ciTimeToGreenArgs";
import {
  BudgetedGhApi,
  FetchStoppedError,
  fetchBundle,
  fetchRequiredChecks,
  type CacheStore,
  type GhApi,
} from "./ciTimeToGreenFetch";
import { buildReport, renderMarkdown, type Bundle } from "./ciTimeToGreenReport";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { createPathClassifier, parseWorkflowPathFilters } from "./prPathClassification";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

class GhApiError extends Error {}

const TRANSIENT_ATTEMPTS = 4;

const ghCli: GhApi = {
  async get(path) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { stdout } = await execFileAsync(
          "gh",
          ["api", "-H", "Accept: application/vnd.github+json", path],
          { maxBuffer: 256 * 1024 * 1024 },
        );
        return JSON.parse(stdout);
      } catch (error) {
        const text = `${(error as { stderr?: string }).stderr ?? ""} ${(error as Error).message}`;
        if (/rate limit|HTTP 429|abuse detection/i.test(text)) {
          throw new FetchStoppedError("rate-limit", `GitHub API rate limit hit on ${path}`);
        }
        const permanent = /HTTP (401|403|404|422)/.test(text) || attempt >= TRANSIENT_ATTEMPTS;
        if (permanent) {
          throw new GhApiError(`gh api ${path} failed: ${text.trim().slice(0, 300)}`);
        }
        // TLS handshake timeouts and 5xx are transient; back off and retry the same GET.
        await defaultTimer.sleep(attempt * 2000);
      }
    }
  },
};

function fileCache(dir: string): CacheStore {
  mkdirSync(dir, { recursive: true });
  return {
    read(key) {
      const file = join(dir, `${key}.json`);
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    },
    write(key, value) {
      writeFileSync(join(dir, `${key}.json`), JSON.stringify(value));
    },
  };
}

async function resolveRepo(options: CliOptions): Promise<string> {
  if (options.repo) {
    return options.repo;
  }
  const { stdout } = await execFileAsync("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  return stdout.trim();
}

async function loadBundle(options: CliOptions): Promise<Bundle> {
  if (options.fromBundle) {
    return JSON.parse(readFileSync(options.fromBundle, "utf8")) as Bundle;
  }
  const workflowFile =
    options.workflowFile ?? join(REPO_ROOT, ".github/workflows/pull_request.yml");
  const classify = createPathClassifier(
    parseWorkflowPathFilters(readFileSync(workflowFile, "utf8")),
  );
  const repo = await resolveRepo(options);
  const api = new BudgetedGhApi(ghCli, options.maxApiCalls);
  const cacheDir = options.cacheDir ?? mkdtempSync(join(tmpdir(), "ci-time-to-green-"));
  const requiredChecks = await fetchRequiredChecks(api, repo);
  if (requiredChecks.length === 0) {
    throw new GhApiError(`no active required_status_checks ruleset found for ${repo}`);
  }
  const bundle = await fetchBundle(
    api,
    fileCache(cacheDir),
    {
      repo,
      sinceMs: options.sinceMs,
      untilMs: options.untilMs,
      prRunsOnly: options.prRunsOnly,
      concurrency: options.concurrency,
      classify,
    },
    requiredChecks,
  );
  console.error(`fetched with ${api.calls} API calls (cache: ${cacheDir})`);
  if (options.saveBundle) {
    mkdirSync(dirname(options.saveBundle), { recursive: true });
    writeFileSync(options.saveBundle, JSON.stringify(bundle));
  }
  return bundle;
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseCliArgs(argv, Date.now(), REPO_ROOT, tmpdir());
  if (options.help) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  const bundle = await loadBundle(options);
  const report = buildReport(bundle, options.prType);
  process.stdout.write(
    options.json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report),
  );
  return EXIT_OK;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`error: ${error.message}\n\n${USAGE}`);
      process.exit(EXIT_USAGE);
    }
    if (error instanceof FetchStoppedError) {
      console.error(
        `stopped: ${error.message}. Fetched items are cached; rerun with the same --cache-dir to resume.`,
      );
      process.exit(EXIT_STOPPED);
    }
    if (error instanceof GhApiError) {
      console.error(`error: ${error.message}`);
      process.exit(EXIT_API);
    }
    console.error(error);
    process.exit(EXIT_UNEXPECTED);
  },
);
