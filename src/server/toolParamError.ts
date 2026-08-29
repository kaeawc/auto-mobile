import { ZodError, type ZodIssue } from "zod/v4";

// Provenance of a flattened issue relative to the OUTERMOST `z.union` it came from
// — the union that actually discriminates the caller's shape. A field that fails in
// EVERY branch of that union is a shared constraint the caller must satisfy no
// matter which branch they meant (genuine); one that fails in only SOME branches is
// branch-discrimination noise. The outermost union is used deliberately: a missing
// field whose value type is ITSELF a union would otherwise look "universal" inside
// that inner type-union (every inner arm reports it missing) even though the field
// is an optional predicate the caller simply omitted. `unionId` scopes the "every
// branch" test; `branchCount` is that union's arm count (#5854).
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
      // Establish a context only for the outermost union; a nested union keeps the
      // outer branch's context so its issues stay attributed to the discriminating
      // arm the caller actually took.
      const outer = union;
      const unionId = outer ? outer.unionId : unionCounter++;
      const branchCount = outer ? outer.branchCount : issue.errors.length;
      issue.errors.forEach((unionIssues, branchIndex) => {
        const branchContext: UnionContext = outer ?? { unionId, branchIndex, branchCount };
        unionIssues.forEach((unionIssue) => {
          const normalizedIssue = issue.path.length
            ? { ...unionIssue, path: [...issue.path, ...unionIssue.path] }
            : unionIssue;
          visit(normalizedIssue as ZodIssue, branchContext);
        });
      });
      return;
    }
    flattened.push({ issue, union });
  };

  issues.forEach((issue) => visit(issue, null));
  return { issues: flattened, sawUnion: unionCounter > 0 };
}

// A field declared `never` on this branch — a structural "this field is forbidden
// here" marker that only ever fires because the union tried an inapplicable branch.
// Always noise, so it is dropped before the across-all-branches test. Missing and
// wrong-value issues are NOT pre-filtered: the coverage test keeps them when the
// field fails in every branch (a genuinely-required field, or a shared constraint)
// and drops them otherwise (a branch-specific discriminator) (#5854).
function isNeverArtifact(issue: ZodIssue): boolean {
  return issue.code === "invalid_type" && issue.expected === "never";
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

// Walk `rawInput` along `path`; true only when every segment resolves through an
// object and the terminal value is not `undefined`. A value the caller actually
// SUPPLIED that is wrong (e.g. a number where a string is required) is a genuine
// mistake we must surface even when only the input's *viable* union arms flag it;
// a field the caller OMITTED is judged by branch coverage instead, so inner-union
// discriminators the caller never provided stay suppressed (#5862).
function isProvidedInput(rawInput: unknown, path: ReadonlyArray<PropertyKey>): boolean {
  let current = rawInput;
  for (const segment of path) {
    if (current === null || typeof current !== "object") {
      return false;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
    if (current === undefined) {
      return false;
    }
  }
  return current !== undefined;
}

// Lead with the actionable message rather than a union-branch dump (#5854).
// A union-derived issue on a field the caller OMITTED is genuine only if its path
// fails in EVERY branch of its union (a shared constraint the caller must fix
// regardless of intended branch); an issue in only some branches is
// branch-discrimination noise. A field the caller PROVIDED is genuine when every
// arm that could apply to it flags it — arms that rejected a strict ancestor of
// the path as `never` are inapplicable (they forbid the whole subtree and never
// evaluate the field), so they are excluded from the denominator instead of
// counting the field as failing in "only some" arms (#5862). Non-union issues
// (top-level siblings) are always kept. Returns the full list unchanged when no
// union expanded, or when suppression would leave nothing — that fallback is
// never worse than the raw dump this replaces.
function selectGenuineIssues(
  flattenedIssues: FlattenedIssue[],
  sawUnion: boolean,
  rawInput: unknown,
): FlattenedIssue[] {
  if (!sawUnion) {
    return flattenedIssues;
  }

  // Per (union, path): which branches reported any issue there. A path covered by
  // all `branchCount` branches is a shared constraint. Alongside, per union, the
  // paths each branch rejected as `never` — used to discount inapplicable arms
  // from a provided field's viable-arm denominator.
  const branchCoverage = new Map<string, Set<number>>();
  const neverPathsByUnion = new Map<number, Array<{ branchIndex: number; path: string }>>();
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

    if (isNeverArtifact(entry.issue)) {
      const nevers = neverPathsByUnion.get(entry.union.unionId) ?? [];
      nevers.push({
        branchIndex: entry.union.branchIndex,
        path: entry.issue.path.map(String).join("."),
      });
      neverPathsByUnion.set(entry.union.unionId, nevers);
    }
  }

  // Arms viable for `path`: `branchCount` minus the arms that rejected a STRICT
  // ancestor of `path` as `never` (those arms forbid the subtree, so they never
  // evaluate the field and must not count against its coverage).
  const viableBranchCount = (union: UnionContext, path: ReadonlyArray<PropertyKey>): number => {
    const nevers = neverPathsByUnion.get(union.unionId);
    if (!nevers || nevers.length === 0) {
      return union.branchCount;
    }
    const segs = path.map(String);
    const strictAncestors = new Set<string>();
    for (let i = 1; i < segs.length; i++) {
      strictAncestors.add(segs.slice(0, i).join("."));
    }
    if (strictAncestors.size === 0) {
      return union.branchCount;
    }
    const excluded = new Set<number>();
    for (const never of nevers) {
      if (strictAncestors.has(never.path)) {
        excluded.add(never.branchIndex);
      }
    }
    return union.branchCount - excluded.size;
  };

  const isGenuine = (entry: FlattenedIssue): boolean => {
    if (!entry.union) {
      return true;
    }
    if (isNeverArtifact(entry.issue)) {
      return false;
    }
    const key = coverageKey(entry.union.unionId, entry.issue.path);
    const coverage = branchCoverage.get(key)?.size ?? 0;
    if (isProvidedInput(rawInput, entry.issue.path)) {
      return coverage === viableBranchCount(entry.union, entry.issue.path);
    }
    return coverage === entry.union.branchCount;
  };

  const primary = flattenedIssues.filter(isGenuine);
  return primary.length > 0 ? primary : flattenedIssues;
}

// Exported for direct unit testing of the container-hint branch (issue #4181,
// rank 7). The hint is only appended for tapOn/swipeOn container issues.
// `rawInput` is the object handed to `schema.parse` (undefined when a caller has
// no access to it — the message is then computed from branch coverage alone,
// identical to pre-#5862 behavior). Threading it lets a provided-value error on a
// nested field survive even when an inapplicable union arm rejects its parent as
// `never` (#5862).
export function formatToolParamError(toolName: string, error: unknown, rawInput?: unknown): string {
  if (!(error instanceof ZodError)) {
    return String(error);
  }

  const { issues: flattenedIssues, sawUnion } = flattenZodIssues(error.issues);
  const selectedIssues = selectGenuineIssues(flattenedIssues, sawUnion, rawInput);

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
