import { ZodError, type ZodIssue } from "zod/v4";

// Provenance of a flattened issue relative to the nearest `z.union` it came from.
// A field that fails in EVERY branch of a union is a shared constraint the caller
// must satisfy no matter which branch they meant (genuine); one that fails in only
// SOME branches is branch-discrimination noise. `unionId` scopes the "every
// branch" test to a specific union (nested unions get their own id); `branchCount`
// is that union's arm count (#5854).
interface UnionContext {
  unionId: number;
  branchIndex: number;
  branchCount: number;
}

interface FlattenedIssue {
  issue: ZodIssue;
  // null when the issue is not union-derived (a top-level sibling, e.g. a bad enum
  // on a field beside a union-typed field) — those are always the caller's real
  // mistake and are never suppressed.
  union: UnionContext | null;
}

interface FlattenResult {
  issues: FlattenedIssue[];
  sawUnion: boolean;
}

function flattenZodIssues(issues: ZodIssue[]): FlattenResult {
  const flattened: FlattenedIssue[] = [];
  let unionCounter = 0;

  const visit = (issue: ZodIssue, union: UnionContext | null) => {
    if (issue.code === "invalid_union" && Array.isArray(issue.errors) && issue.errors.length) {
      const unionId = unionCounter++;
      const branchCount = issue.errors.length;
      issue.errors.forEach((unionIssues, branchIndex) => {
        unionIssues.forEach((unionIssue) => {
          const normalizedIssue = issue.path.length
            ? { ...unionIssue, path: [...issue.path, ...unionIssue.path] }
            : unionIssue;
          // Re-tag with this union's context so the nearest enclosing union wins
          // for nested unions.
          visit(normalizedIssue as ZodIssue, { unionId, branchIndex, branchCount });
        });
      });
      return;
    }
    flattened.push({ issue, union });
  };

  issues.forEach((issue) => visit(issue, null));
  return { issues: flattened, sawUnion: unionCounter > 0 };
}

// zod v4 does not reliably populate `issue.received`: a non-finite number carries
// `received: "Infinity"`, but a genuine wrong type (string→number) or an absent
// field leaves it undefined and encodes the value only in the message text
// ("… received string" / "… received undefined"). So "was this field actually
// supplied?" must be read from the message, not the (often-missing) field.
function issueReportsMissingValue(issue: ZodIssue): boolean {
  const received = (issue as { received?: unknown }).received;
  if (received !== undefined) {
    return received === "undefined";
  }
  return /received undefined$/.test(issue.message ?? "");
}

// A field the caller did not supply on this branch (`received undefined`) or one
// that is `never` on this branch — pure branch-discrimination artifacts, never the
// caller's real mistake, so always suppressible when union-derived. A provided-bad
// value (a non-finite number, a wrong type, a bad enum) is NOT an artifact; whether
// it is genuine is decided separately by the across-all-branches test (#5854).
function isMissingOrNeverArtifact(issue: ZodIssue): boolean {
  if (issue.code !== "invalid_type") {
    return false;
  }
  return issue.expected === "never" || issueReportsMissingValue(issue);
}

// Key for the (union, path) coverage map. `unionId` is a number and "#" cannot
// appear in it, so the boundary with the joined path is unambiguous even when a
// path segment contains digits.
function coverageKey(unionId: number, path: ReadonlyArray<PropertyKey>): string {
  return `${unionId}#${path.map(String).join(".")}`;
}

function formatIssue(issue: ZodIssue): string {
  const path = issue.path.length ? issue.path.join(".") : "parameters";
  if (issue.code === "invalid_type") {
    // zod v4 rejects non-finite numbers (Infinity/-Infinity/NaN) at the base
    // `z.number()` check, so no `.finite()` refinement can carry a custom
    // message. Those surface as an invalid_type whose value is still a number
    // (`received` is "Infinity"/"NaN", or "number" from a typeof-based error
    // map), collapsing the default text to the self-contradictory "expected
    // number, received number". A finite number never trips invalid_type, so
    // any of these markers means non-finite — name the real constraint (#5769).
    const received = (issue as { received?: unknown }).received;
    if (
      issue.expected === "number" &&
      (received === "Infinity" || received === "NaN" || received === "number")
    ) {
      return `${path} must be a finite number`;
    }
    // zod v4 issues otherwise carry a usable default message that already
    // reads "Invalid input: expected X, received Y", so reuse it minus the
    // prefix to keep the historical "<path> expected X" format.
    return `${path} ${issue.message.replace(/^Invalid input: /, "")}`;
  }
  return `${path} ${issue.message}`;
}

// Lead with the actionable message rather than a union-branch dump (#5854).
// A union-derived issue is genuine only if its path fails in EVERY branch of its
// union (a shared constraint the caller must fix regardless of intended branch);
// an issue in only some branches is branch-discrimination noise. Non-union issues
// (top-level siblings) are always kept. Returns the full list unchanged when no
// union expanded, or when suppression would leave nothing — that fallback is
// never worse than the raw dump this replaces.
function selectGenuineIssues(
  flattenedIssues: FlattenedIssue[],
  sawUnion: boolean,
): FlattenedIssue[] {
  if (!sawUnion) {
    return flattenedIssues;
  }

  // Per (union, path): which branches reported any issue there. A path covered by
  // all `branchCount` branches is a shared constraint.
  const branchCoverage = new Map<string, Set<number>>();
  for (const entry of flattenedIssues) {
    if (!entry.union) {
      continue;
    }
    const key = coverageKey(entry.union.unionId, entry.issue.path);
    let branches = branchCoverage.get(key);
    if (!branches) {
      branches = new Set<number>();
      branchCoverage.set(key, branches);
    }
    branches.add(entry.union.branchIndex);
  }

  const isGenuine = (entry: FlattenedIssue): boolean => {
    if (!entry.union) {
      return true;
    }
    if (isMissingOrNeverArtifact(entry.issue)) {
      return false;
    }
    const key = coverageKey(entry.union.unionId, entry.issue.path);
    return (branchCoverage.get(key)?.size ?? 0) === entry.union.branchCount;
  };

  const primary = flattenedIssues.filter(isGenuine);
  return primary.length > 0 ? primary : flattenedIssues;
}

// Exported for direct unit testing of the container-hint branch (issue #4181,
// rank 7). The hint is only appended for tapOn/swipeOn container issues.
export function formatToolParamError(toolName: string, error: unknown): string {
  if (!(error instanceof ZodError)) {
    return String(error);
  }

  const { issues: flattenedIssues, sawUnion } = flattenZodIssues(error.issues);
  const selectedIssues = selectGenuineIssues(flattenedIssues, sawUnion);

  // Dedupe formatted messages: union expansion repeats the same real issue once
  // per branch that carries the field.
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const { issue } of selectedIssues) {
    const formatted = formatIssue(issue);
    if (!seen.has(formatted)) {
      seen.add(formatted);
      issues.push(formatted);
    }
  }

  const hints: string[] = [];
  if (toolName === "swipeOn" || toolName === "tapOn") {
    const containerIssue = flattenedIssues.find((entry) => entry.issue.path[0] === "container");
    if (containerIssue) {
      hints.push(
        'container must be an object like { "elementId": "<id>" } or { "text": "<text>" }',
      );
    }
  }

  const issueSummary = issues.join("; ");
  const hintSummary = hints.length > 0 ? ` Hint: ${hints.join(" ")}` : "";
  return `${issueSummary}${hintSummary}`;
}
