import { ZodError, type ZodIssue } from "zod/v4";

interface FlattenResult {
  issues: ZodIssue[];
  // A `z.union` was expanded during flattening. Union expansion produces one
  // issue per branch, so the same real problem repeats and every branch also
  // reports its own discriminator/required fields as missing — noise that only
  // exists because a union was tried (#5854).
  sawUnion: boolean;
}

function flattenZodIssues(issues: ZodIssue[]): FlattenResult {
  const flattened: ZodIssue[] = [];
  let sawUnion = false;

  const visit = (issue: ZodIssue) => {
    if (issue.code === "invalid_union" && Array.isArray(issue.errors) && issue.errors.length) {
      sawUnion = true;
      issue.errors.forEach((unionIssues) => {
        unionIssues.forEach((unionIssue) => {
          const normalizedIssue = issue.path.length
            ? { ...unionIssue, path: [...issue.path, ...unionIssue.path] }
            : unionIssue;
          visit(normalizedIssue as ZodIssue);
        });
      });
      return;
    }
    flattened.push(issue);
  };

  issues.forEach(visit);
  return { issues: flattened, sawUnion };
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

// A union branch reports fields it needs but the caller didn't supply, and fields
// that are `never` on that branch — pure branch-discrimination artifacts, not the
// caller's actual mistake. Recognizing them lets the formatter lead with the real
// problem (a field the caller DID provide with a bad value) instead of a
// per-branch dump (#5854). This is only consulted for union-derived errors; a
// plain object schema's "missing required field" is genuine signal.
function isBranchDiscriminationNoise(issue: ZodIssue): boolean {
  if (issue.code === "invalid_type") {
    // Field not valid on this branch (`never`), or a required field the caller
    // omitted. A provided-but-bad value (e.g. a non-finite number or a wrong
    // type) is the real problem and is kept.
    return issue.expected === "never" || issueReportsMissingValue(issue);
  }
  // A missing/misused literal-or-enum discriminator selecting the branch.
  return issue.code === "invalid_value";
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

// Exported for direct unit testing of the container-hint branch (issue #4181,
// rank 7). The hint is only appended for tapOn/swipeOn container issues.
export function formatToolParamError(toolName: string, error: unknown): string {
  if (!(error instanceof ZodError)) {
    return String(error);
  }

  const { issues: flattenedIssues, sawUnion } = flattenZodIssues(error.issues);

  // Lead with the actionable message rather than a union-branch dump (#5854).
  // When a union expanded, drop the per-branch discrimination noise so the real
  // problem surfaces first; fall back to the full list if suppression would leave
  // nothing (e.g. the caller supplied no bad value, only ambiguous/missing
  // fields — then the per-branch requirements ARE the guidance to show).
  let selectedIssues = flattenedIssues;
  if (sawUnion) {
    const primary = flattenedIssues.filter((issue) => !isBranchDiscriminationNoise(issue));
    if (primary.length > 0) {
      selectedIssues = primary;
    }
  }

  // Dedupe formatted messages: union expansion repeats the same real issue once
  // per branch that carries the field.
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const issue of selectedIssues) {
    const formatted = formatIssue(issue);
    if (!seen.has(formatted)) {
      seen.add(formatted);
      issues.push(formatted);
    }
  }

  const hints: string[] = [];
  if (toolName === "swipeOn" || toolName === "tapOn") {
    const containerIssue = flattenedIssues.find((issue) => issue.path[0] === "container");
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
