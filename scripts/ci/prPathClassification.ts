/**
 * PR type from changed paths, for the CI time-to-green report (#11582).
 *
 * The path filters are NOT restated here: the android / ios / ts lists are read from the
 * `dorny/paths-filter` steps in `.github/workflows/pull_request.yml`, the same lists that gate which
 * jobs run. Only the docs-only patterns live in an inline `actions/github-script` block that cannot
 * be parsed as data, so they are mirrored below and a unit test fails if the workflow stops
 * containing them.
 */
import { load } from "js-yaml";

export const PR_TYPES = ["ts-only", "android", "ios", "shell-docs", "mixed", "unknown"] as const;
export type PrType = (typeof PR_TYPES)[number];

export interface WorkflowPathFilters {
  android: readonly string[];
  ios: readonly string[];
  ts: readonly string[];
}

/**
 * Mirrors `docPatterns` in pull_request.yml's "documentation-only" step, written exactly as the
 * JavaScript regex literals appear there so a test can find each one in the workflow text.
 */
export const DOC_PATTERN_LITERALS: readonly string[] = [
  "/\\.md$/",
  "/^docs\\//",
  "/^docs-assets\\//",
  "/^mkdocs\\.yml$/",
  "/^\\.lycherc\\.toml$/",
];
export const TEST_GUARDED_DOCS: readonly string[] = ["docs/using/screen-control.md"];

const DOC_PATTERNS = DOC_PATTERN_LITERALS.map((literal) => new RegExp(literal.slice(1, -1)));

interface WorkflowStep {
  id?: string;
  with?: { filters?: string };
}

interface WorkflowDocument {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

function filterGlobs(steps: readonly WorkflowStep[], stepId: string, key: string): string[] {
  const step = steps.find((candidate) => candidate.id === stepId);
  const filters = step?.with?.filters;
  if (typeof filters !== "string") {
    throw new Error(`pull_request.yml has no paths-filter step "${stepId}" with a filters block`);
  }
  const parsed = load(filters) as Record<string, unknown> | null;
  const globs = parsed?.[key];
  if (!Array.isArray(globs) || !globs.every((glob) => typeof glob === "string")) {
    throw new Error(`paths-filter step "${stepId}" has no "${key}" glob list`);
  }
  return globs as string[];
}

/** Reads the android / ios / ts globs from the text of pull_request.yml. */
export function parseWorkflowPathFilters(workflowYaml: string): WorkflowPathFilters {
  const document = load(workflowYaml) as WorkflowDocument | null;
  const steps = Object.values(document?.jobs ?? {}).flatMap((job) => job.steps ?? []);
  return {
    android: filterGlobs(steps, "filter-android", "android"),
    ios: filterGlobs(steps, "filter-ios", "ios"),
    ts: filterGlobs(steps, "filter-ts", "ts"),
  };
}

export function isDocFile(path: string): boolean {
  return !TEST_GUARDED_DOCS.includes(path) && DOC_PATTERNS.some((pattern) => pattern.test(path));
}

export interface GlobMatcher {
  match(path: string): boolean;
}

export type GlobMatcherFactory = (glob: string) => GlobMatcher;

/** bun's glob implementation; dorny/paths-filter uses micromatch with `dot: true`. */
export const bunGlobMatcher: GlobMatcherFactory = (glob) => new Bun.Glob(glob);

function anyMatch(matchers: readonly GlobMatcher[], path: string): boolean {
  return matchers.some((matcher) => matcher.match(path));
}

function isShellFile(path: string): boolean {
  return path.endsWith(".sh") || path.startsWith("test/bats/");
}

export type PathClassifier = (files: readonly string[] | null) => PrType;

export function createPathClassifier(
  filters: WorkflowPathFilters,
  globFactory: GlobMatcherFactory = bunGlobMatcher,
): PathClassifier {
  const android = filters.android.map(globFactory);
  const ios = filters.ios.map(globFactory);
  const ts = filters.ts.map(globFactory);
  return (files) => {
    if (files === null || files.length === 0) {
      return "unknown";
    }
    if (files.every(isDocFile)) {
      return "shell-docs";
    }
    const touchesAndroid = files.some((file) => anyMatch(android, file));
    const touchesIos = files.some((file) => anyMatch(ios, file));
    if (touchesAndroid && touchesIos) {
      return "mixed";
    }
    if (touchesAndroid) {
      return "android";
    }
    if (touchesIos) {
      return "ios";
    }
    const touchesTs = files.some(
      (file) => anyMatch(ts, file) && !isShellFile(file) && !isDocFile(file),
    );
    return touchesTs ? "ts-only" : "shell-docs";
  };
}
