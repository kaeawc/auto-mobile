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
  // mistake and are never suppressed. Equal to `chain[0]`, the OUTERMOST union.
  union: UnionContext | null;
  // Every union the issue passed through, outermost first. Suppression
  // (`selectGenuineIssues`) deliberately reasons about the outermost union alone,
  // but merging unrecognized-key sets must keep the inner arms apart: they all
  // carry the same OUTER branch index, so collapsing them loses the fact that an
  // inner arm ACCEPTED a key (PR #6882 review).
  chain: readonly UnionContext[];
}

interface FlattenResult {
  issues: FlattenedIssue[];
  sawUnion: boolean;
}

function flattenZodIssues(issues: ZodIssue[]): FlattenResult {
  const flattened: FlattenedIssue[] = [];
  let unionCounter = 0;

  const visit = (issue: ZodIssue, chain: readonly UnionContext[]) => {
    if (issue.code === "invalid_union" && Array.isArray(issue.errors) && issue.errors.length) {
      // Every union gets its own context, appended to the chain. `chain[0]` stays
      // the outermost union, so an issue reached through a nested union remains
      // attributed to the discriminating outer arm the caller actually took while
      // the inner arm it came from is still recoverable.
      const unionId = unionCounter++;
      const branchCount = issue.errors.length;
      issue.errors.forEach((unionIssues, branchIndex) => {
        const nested: readonly UnionContext[] = [...chain, { unionId, branchIndex, branchCount }];
        unionIssues.forEach((unionIssue) => {
          const normalizedIssue = issue.path.length
            ? { ...unionIssue, path: [...issue.path, ...unionIssue.path] }
            : unionIssue;
          visit(normalizedIssue as ZodIssue, nested);
        });
      });
      return;
    }
    flattened.push({ issue, union: chain[0] ?? null, chain });
  };

  issues.forEach((issue) => visit(issue, []));
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

// ---------------------------------------------------------------------------
// Unrecognized keys across union branches (#6867)
// ---------------------------------------------------------------------------

// zod reports `unrecognized_keys` once PER BRANCH of a union, and each branch
// names every key IT does not accept. Concatenating those lists tells the caller
// that a key one branch accepts is unrecognized — in the same sentence that lists
// it as accepted. Only the INTERSECTION across all branches is genuinely unknown:
// a key accepted by any branch is never unrecognized. A branch that reported no
// unrecognized key at all accepts every supplied key, so it contributes the empty
// set and collapses the intersection (#6867).
interface UnrecognizedGroup {
  // Rejected by every branch — the keys that are actually unknown.
  intersection: string[];
  // Rejected by at least one branch, first-seen order. When `intersection` is
  // empty these are valid keys that belong to mutually exclusive branches.
  reported: string[];
  // Known keys that no single branch accepts together, first-seen order, or
  // empty when some branch accepts them all. Non-empty ALONGSIDE a non-empty
  // `intersection` when the caller sent both an unknown key and keys from two
  // arms: naming only the unknown one would leave the request invalid after the
  // caller fixed it (PR #6882 review).
  exclusive: string[];
}

type UnrecognizedKeysIssue = Extract<ZodIssue, { code: "unrecognized_keys" }>;

function isUnrecognizedKeys(issue: ZodIssue): issue is UnrecognizedKeysIssue {
  return issue.code === "unrecognized_keys";
}

// Re-issue the branch's own issue with the merged key set and sentence. Keeping
// the `unrecognized_keys` code means tool-specific formatting (the "Accepted: …"
// list) still applies; only the key list and wording change.
function withMergedKeys(
  issue: UnrecognizedKeysIssue,
  keys: string[],
  message: string,
): UnrecognizedKeysIssue {
  return { ...issue, keys, message };
}

// One branch's unrecognized-key report, tagged with the union arms it travelled
// through so nested unions can be intersected at their own level.
interface KeyReport {
  chain: readonly UnionContext[];
  keys: string[];
}

// Rejected-by-every-arm keys for one union level, recursing into nested unions.
// At each level: an arm that reported nothing accepts every supplied key, so the
// level collapses to the empty set; otherwise the arms' own sets (themselves
// resolved one level deeper) are intersected. Reports that carry no further union
// context are merged with a set union — they come from one object schema, which
// emits at most one `unrecognized_keys` issue.
// The arms of the union at `level`, when every report belongs to it. `undefined`
// means the reports do not share one union at this level, so there is nothing to
// intersect: they came from a single object schema.
function armsAtLevel(
  reports: readonly KeyReport[],
  level: number,
): { context: UnionContext; byArm: Map<number, KeyReport[]> } | undefined {
  const context = reports[0]?.chain[level];
  const sameUnion = (report: KeyReport): boolean =>
    report.chain[level]?.unionId === context?.unionId;
  if (!context || !reports.every(sameUnion)) {
    return undefined;
  }
  const byArm = new Map<number, KeyReport[]>();
  for (const report of reports) {
    const arm = report.chain[level].branchIndex;
    byArm.set(arm, [...(byArm.get(arm) ?? []), report]);
  }
  return { context, byArm };
}

function rejectedByEveryArm(reports: readonly KeyReport[], level: number): Set<string> {
  const arms = armsAtLevel(reports, level);
  if (!arms) {
    return new Set(reports.flatMap((report) => report.keys));
  }
  if (arms.byArm.size !== arms.context.branchCount) {
    return new Set<string>();
  }
  const [first, ...rest] = [...arms.byArm.values()].map((arm) =>
    rejectedByEveryArm(arm, level + 1),
  );
  return new Set([...first].filter((name) => rest.every((arm) => arm.has(name))));
}

// The known keys one arm cannot accept together: the ones it rejects outright,
// plus the ones a union NESTED inside it makes mutually exclusive. An arm whose
// set is empty accepts the whole supplied set, so the level it belongs to has no
// conflict at all.
function unsatisfiedKeys(
  reports: readonly KeyReport[],
  unknown: ReadonlySet<string>,
  level: number,
): Set<string> {
  const rejected = [...rejectedByEveryArm(reports, level)].filter((name) => !unknown.has(name));
  return new Set([...rejected, ...mutuallyExclusiveKeys(reports, unknown, level)]);
}

// The keys that make the arms mutually exclusive, ignoring the keys `unknown` to
// every arm (those are reported as unrecognized, not as a choice). There is a
// conflict only when NO arm accepts the whole supplied set: every arm rejected
// at least one known key, or could not combine the keys of a union nested inside
// it. An arm that accepts them all means there is no conflict, so a valid key
// beside an unknown one is never mistaken for one. The nested case matters
// because an inner union's arms individually accept both conflicting keys, so
// the inner level reduces to the shared unknown key and the conflict is only
// visible at the level where it occurs (PR #6882 review).
function mutuallyExclusiveKeys(
  reports: readonly KeyReport[],
  unknown: ReadonlySet<string>,
  level = 0,
): Set<string> {
  const arms = armsAtLevel(reports, level);
  if (!arms || arms.byArm.size !== arms.context.branchCount) {
    return new Set<string>();
  }
  const perArm = [...arms.byArm.values()].map((arm) => unsatisfiedKeys(arm, unknown, level + 1));
  if (perArm.some((keys) => keys.size === 0)) {
    return new Set<string>();
  }
  return new Set(perArm.flatMap((keys) => [...keys]));
}

function groupUnrecognizedKeys(flattenedIssues: FlattenedIssue[]): Map<string, UnrecognizedGroup> {
  const byGroup = new Map<string, KeyReport[]>();
  for (const entry of flattenedIssues) {
    if (!entry.union || !isUnrecognizedKeys(entry.issue)) {
      continue;
    }
    const key = coverageKey(entry.union.unionId, entry.issue.path);
    const reports = byGroup.get(key) ?? [];
    reports.push({ chain: entry.chain, keys: entry.issue.keys.map(String) });
    byGroup.set(key, reports);
  }

  const merged = new Map<string, UnrecognizedGroup>();
  for (const [key, reports] of byGroup) {
    const reported = [...new Set(reports.flatMap((report) => report.keys))];
    const rejected = rejectedByEveryArm(reports, 0);
    const exclusive = mutuallyExclusiveKeys(reports, rejected);
    // "provide exactly one" is only true of two or more keys the caller
    // actually supplied. One key on its own is never a choice (PR #6882
    // review).
    const exclusiveKeys = reported.filter((name) => exclusive.has(name));
    merged.set(key, {
      intersection: reported.filter((name) => rejected.has(name)),
      reported,
      exclusive: exclusiveKeys.length > 1 ? exclusiveKeys : [],
    });
  }
  return merged;
}

function quoteKeys(keys: ReadonlyArray<string>): string {
  return keys.map((name) => `"${name}"`).join(", ");
}

// Mirrors zod's own phrasing so a single-key message is byte-identical to what
// an un-merged branch would have produced.
function unrecognizedKeysMessage(keys: ReadonlyArray<string>): string {
  return keys.length === 1
    ? `Unrecognized key: ${quoteKeys(keys)}`
    : `Unrecognized keys: ${quoteKeys(keys)}`;
}

function mutuallyExclusiveMessage(keys: ReadonlyArray<string>): string {
  return `Mutually exclusive keys: ${quoteKeys(keys)} — provide exactly one.`;
}

// A nested object key that is ALSO a parameter of the tool itself: the caller put
// `index` inside `selector` when `index` is a sibling of `selector`. Naming the
// key as unknown without saying where it does belong leaves no next step (#6867).
function topLevelHint(
  path: ReadonlyArray<PropertyKey>,
  keys: ReadonlyArray<string>,
  siblingKeys: ReadonlySet<string>,
  suppliedKeys: ReadonlySet<string>,
): string {
  if (path.length === 0 || siblingKeys.size === 0) {
    return "";
  }
  const owner = String(path[0]);
  // A parameter the caller already supplied at the top level is not what they
  // "meant" by the nested copy: the remedy is deleting the duplicate, not
  // moving it to a key that is already there (PR #6882 review).
  const promoted = keys.filter(
    (name) => name !== owner && siblingKeys.has(name) && !suppliedKeys.has(name),
  );
  if (promoted.length === 0) {
    return "";
  }
  const plural = promoted.length === 1 ? "parameter" : "parameters";
  return ` — did you mean the top-level ${quoteKeys(promoted)} ${plural}?`;
}

// The top-level keys the caller actually sent, read off the raw input rather
// than the parsed output: validation failed, so there is no parsed output.
function suppliedTopLevelKeys(rawInput: unknown): ReadonlySet<string> {
  if (typeof rawInput !== "object" || rawInput === null || Array.isArray(rawInput)) {
    return new Set<string>();
  }
  return new Set(
    Object.entries(rawInput)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name),
  );
}

interface ZodDefLike {
  type?: string;
  in?: unknown;
  out?: unknown;
  innerType?: unknown;
  options?: readonly unknown[];
}

interface ZodSchemaLike {
  def?: ZodDefLike;
  shape?: Record<string, unknown>;
}

function asZodSchemaLike(value: unknown): ZodSchemaLike | undefined {
  return typeof value === "object" && value !== null ? (value as ZodSchemaLike) : undefined;
}

// The tool's own top-level parameter names, read off the schema the caller parsed
// with rather than a hardcoded list, so the hint stays correct for every tool and
// cannot drift as parameters are added. Wrappers (`.pipe`, `.optional`, effects)
// are unwrapped; a union of objects contributes every arm's keys.
function topLevelSchemaKeys(schema: unknown, depth = 0): ReadonlySet<string> {
  const node = depth > 8 ? undefined : asZodSchemaLike(schema);
  const def = node?.def;
  if (!node || !def) {
    return new Set<string>();
  }
  if (node.shape) {
    return new Set(Object.keys(node.shape));
  }
  if (Array.isArray(def.options)) {
    return new Set(def.options.flatMap((option) => [...topLevelSchemaKeys(option, depth + 1)]));
  }
  // Both ends of a pipe carry parameter names worth hinting at, and only one of
  // them ever does: `withFieldAliases` wraps every app-ID-aware schema in
  // `z.preprocess`, whose `in` is the alias-normalizing transform and whose `out`
  // is the object schema — following `in` alone found no keys, so tools such as
  // `observe` never produced the hint at all (#6867, PR review).
  const wrapped = [def.out, def.in, def.innerType].filter((inner) => inner !== undefined);
  return new Set(wrapped.flatMap((inner) => [...topLevelSchemaKeys(inner, depth + 1)]));
}

function formatSelectorIssue(
  issue: ZodIssue,
  toolName: string,
  path: string,
  rawInput: unknown,
): string | undefined {
  if (
    toolName === "tapOn" &&
    path === "selector" &&
    issue.code === "invalid_type" &&
    issue.expected === "object" &&
    rawInput !== undefined &&
    !isProvidedInput(rawInput, issue.path)
  ) {
    return "selector is required: selector: { elementId | testTag | text | accessibilityLink | textAny }";
  }
  if (issue.code !== "unrecognized_keys" || toolName !== "tapOn" || path !== "selector") {
    return undefined;
  }
  return `${path} ${issue.message} Accepted: elementId, testTag, text, accessibilityLink, textAny (content-desc is matched by "text")`;
}

function formatMissingPlatformIssue(
  issue: ZodIssue,
  path: string,
  rawInput: unknown,
): string | undefined {
  if (issue.code !== "invalid_value" || path !== "platform") {
    return undefined;
  }
  return rawInput !== undefined && !isProvidedInput(rawInput, issue.path)
    ? `${path} is required`
    : undefined;
}

function formatIssue(issue: ZodIssue, toolName: string, rawInput: unknown): string {
  const path = issue.path.length ? issue.path.join(".") : "parameters";
  const actionableIssue =
    formatSelectorIssue(issue, toolName, path, rawInput) ??
    formatMissingPlatformIssue(issue, path, rawInput);
  if (actionableIssue) {
    return actionableIssue;
  }
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
// `never` (#5862). `schema` is the tool's own input schema; when supplied, a
// rejected nested key that is a top-level parameter of the tool is named as such
// instead of only being called unknown (#6867).
export function formatToolParamError(
  toolName: string,
  error: unknown,
  rawInput?: unknown,
  schema?: unknown,
): string {
  if (!(error instanceof ZodError)) {
    return String(error);
  }

  const { issues: flattenedIssues, sawUnion } = flattenZodIssues(error.issues);
  const selectedIssues = selectGenuineIssues(flattenedIssues, sawUnion, rawInput);
  const unrecognizedGroups = groupUnrecognizedKeys(flattenedIssues);
  const siblingKeys = topLevelSchemaKeys(schema);
  const suppliedKeys = suppliedTopLevelKeys(rawInput);

  const renderer = (issue: ZodIssue, hintKeys?: ReadonlyArray<string>): string =>
    formatIssue(issue, toolName, rawInput) +
    (hintKeys ? topLevelHint(issue.path, hintKeys, siblingKeys, suppliedKeys) : "");

  // Union branches whose unrecognized-key sets did not intersect: every key is
  // accepted by some branch, so none is unknown. Held back, because a sibling
  // issue from the SAME union usually says the same thing in better words —
  // but only that union's own issues can explain it. An unrelated field's error
  // (a bad `duration` beside a conflicting `selector`) leaves the conflict
  // unexplained, and dropping it there hid a still-invalid selector until the
  // caller retried (#6867, PR review).
  interface HeldConflict {
    issue: UnrecognizedKeysIssue;
    keys: string[];
    unionId: number;
    path: string;
  }
  const conflicts: HeldConflict[] = [];
  // Where each rendered union issue spoke, so a conflict is only held back by a
  // line about the conflicting object ITSELF. A nested union's conflict and an
  // unrelated sibling error carry the SAME outer union id (`waitFor.container`
  // and `waitFor.timeout`), so suppressing by union id alone dropped a conflict
  // the sibling says nothing about. A line about something INSIDE the object
  // (`waitFor.container.elementId` must be a string) does not explain why two of
  // its keys cannot coexist either, so it does not hold the conflict back
  // (PR #6882 review).
  const explanations: Array<{ unionId: number; path: string }> = [];
  const pathOf = (path: ReadonlyArray<PropertyKey>): string => path.map(String).join(".");
  const explains = (conflict: HeldConflict): boolean =>
    explanations.some(
      ({ unionId, path }) =>
        unionId === conflict.unionId && (conflict.path === "" || path === conflict.path),
    );
  // Conflicting keys are RECOGNIZED keys of the object that reported them, so
  // none of them is a misplaced top-level parameter: promoting `selector.text`
  // to `inputText`'s own `text` parameter names a different thing the caller
  // already supplied. Only unrecognized keys are promotable (PR #6882 review).
  const conflictLine = (issue: UnrecognizedKeysIssue, keys: string[]): string =>
    renderer(withMergedKeys(issue, keys, mutuallyExclusiveMessage(keys)));
  const render = (entry: FlattenedIssue): string[] => {
    const { issue } = entry;
    if (!entry.union || !isUnrecognizedKeys(issue)) {
      if (entry.union) {
        explanations.push({ unionId: entry.union.unionId, path: pathOf(issue.path) });
      }
      return [renderer(issue)];
    }
    const group = unrecognizedGroups.get(coverageKey(entry.union.unionId, issue.path));
    if (!group) {
      return [renderer(issue)];
    }
    if (group.intersection.length === 0) {
      // An empty intersection is not by itself a conflict: an arm that reported
      // a VALUE error instead of an unrecognized key never named the key at
      // all, and that incomplete coverage empties the intersection too. Only
      // keys the arms really cannot combine are a choice, so promoting the
      // reported set invented "Mutually exclusive keys: \"text\"" for a single
      // supplied key whose value was merely the wrong type (PR #6882 review).
      if (group.exclusive.length > 0) {
        conflicts.push({
          issue,
          keys: group.exclusive,
          unionId: entry.union.unionId,
          path: pathOf(issue.path),
        });
      }
      return [];
    }
    explanations.push({ unionId: entry.union.unionId, path: pathOf(issue.path) });
    // The unknown key need not be the only thing wrong: keys from two arms are
    // still mutually exclusive, and naming only the unknown one would cost the
    // caller another round-trip to learn that. Both sentences ride one issue so
    // the tool's "Accepted: …" list is appended once.
    const keys = [...group.intersection, ...group.exclusive];
    const message =
      group.exclusive.length > 0
        ? `${unrecognizedKeysMessage(group.intersection)}. ${mutuallyExclusiveMessage(group.exclusive)}`
        : unrecognizedKeysMessage(group.intersection);
    return [renderer(withMergedKeys(issue, keys, message), group.intersection)];
  };

  // Dedupe formatted messages: union expansion repeats the same real issue once
  // per branch that carries the field.
  const rendered = selectedIssues.flatMap(render);
  // A conflict is "explained" only once one of its union's own issues rendered a
  // line about the conflicting object or something inside it, so when nothing
  // rendered at all every conflict is still emitted — the pre-existing fallback,
  // now reached by the same rule.
  const fallback = conflicts
    .filter((conflict) => !explains(conflict))
    .map(({ issue, keys }) => conflictLine(issue, keys));
  const issues = [...new Set([...rendered, ...fallback])];

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
