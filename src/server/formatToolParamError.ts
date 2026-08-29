import { ZodError, type ZodIssue } from "zod/v4";

export function flattenZodIssues(issues: ZodIssue[]): ZodIssue[] {
  const flattened: ZodIssue[] = [];

  const visit = (issue: ZodIssue) => {
    if (issue.code === "invalid_union" && Array.isArray(issue.errors) && issue.errors.length) {
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
  return flattened;
}

// A `z.union` reports every branch's failure, so a single bad field expands into
// one issue per branch plus a "presence" artifact for every field the branch
// required but the caller never passed (`<field> expected <type>, received
// undefined`) or forbade (`expected never`). Rank issues so the caller's real
// mistake leads and those branch artifacts sink to the end (issue #5854):
//   0 — a concrete value error on a field the caller actually provided.
//   1 — an enum `invalid_value`: usually a union discriminant that failed only
//       because the caller selected a different branch; still shown, just not
//       ahead of a concrete value error.
//   2 — a missing/prohibited-field artifact of an unselected branch.
// Ranking only reorders; a single-issue error is unaffected, so a genuine enum
// or missing-field error still leads when it is the only thing wrong.
function issuePriority(issue: ZodIssue): number {
  if (issue.code === "invalid_type") {
    if (issue.expected === "never") {
      return 2;
    }
    const received = (issue as { received?: unknown }).received;
    if (received === "undefined") {
      return 2;
    }
  }
  if (typeof issue.message === "string" && issue.message.endsWith("received undefined")) {
    return 2;
  }
  if (issue.code === "invalid_value") {
    return 1;
  }
  return 0;
}

function renderIssueMessage(issue: ZodIssue): string {
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

  const flattenedIssues = flattenZodIssues(error.issues);

  // Stable-sort by priority (Array.prototype.sort is stable) so first-seen order
  // is preserved within each tier, then dedup identical rendered fragments — a
  // union surfaces the same real error from several branches.
  const ordered = flattenedIssues
    .slice()
    .sort((a, b) => issuePriority(a) - issuePriority(b));

  const seen = new Set<string>();
  const issues: string[] = [];
  for (const issue of ordered) {
    const message = renderIssueMessage(issue);
    if (seen.has(message)) {
      continue;
    }
    seen.add(message);
    issues.push(message);
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

// The single "Invalid parameters for tool <name>: <formatted>" rendering used at
// the MCP call boundary (src/server/index.ts) and the plan-execution path
// (PlanExecutor), so a validation failure reads identically on both (#5854 AC3).
export function invalidParamsMessage(toolName: string, error: unknown): string {
  return `Invalid parameters for tool ${toolName}: ${formatToolParamError(toolName, error)}`;
}
