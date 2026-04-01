---
name: fan-out-fan-in
description: Use this skill to split a plan into independent work units, execute them in parallel isolated worktrees, and merge all results back into the current branch without creating separate PRs.
---

# Fan Out Fan In

Split a plan into independent work units. Execute each in an isolated worktree. Merge results back to the current branch.

## Step 1: Parse the Plan

The input is a plan file path (e.g., `scratch/plan.md`) or inline description. Read it fully.

Optional constraints may be specified:
- File scope restrictions (which files each unit may touch)
- Commands to avoid (e.g., "do not run ./gradlew")
- Validation command override

## Step 2: Check Preconditions

```bash
PARENT_BRANCH=$(git branch --show-current)
PARENT_COMMIT=$(git rev-parse HEAD)
git status --short
```

Do NOT proceed with a dirty working directory. Stash or commit first.

Detect the project validation command:
```bash
[ -f "turbo.json" ] && echo "turbo run lint build test"
[ -f "package.json" ] && echo "bun run lint && bun run build && bun test"
[ -f "Makefile" ] && echo "make check"
```

## Step 3: Scan for Prior Progress

```bash
git log --oneline -20
git worktree list
```

Cross-reference the plan with recent commits and existing code. Remove work units already implemented.

## Step 4: Split Into Work Units

Decompose the plan into parallelizable units. Each unit must:
- Touch different files (no two units editing the same file)
- Be self-contained and independently validatable
- Have clear acceptance criteria

Present the units before executing:
```
Work Units:
  1. [name] — description (files: src/foo.ts, test/foo.test.ts)
  2. [name] — description (files: src/bar.ts)
  ...
Estimated conflicts: [any shared file concerns]
```

If two units need the same file, either merge them into one unit or sequence them.

## Step 5: Create Worktrees and Execute

For each work unit, create an isolated worktree:

```bash
UNIT_BRANCH="fan-out-unit-N"
git worktree add "../worktree-unit-N" -b "$UNIT_BRANCH" "$PARENT_COMMIT"
```

In each worktree, implement the work unit:
1. Make the changes scoped to the unit's file list
2. Run validation
3. Commit with message: `fan-out: [unit-name]`
4. Do NOT create a PR or push to remote

## Step 6: Validate Each Unit

In each worktree, run the project validation:
```bash
cd ../worktree-unit-N
bun run lint && bun run build && bun test
# Or the appropriate validation for the file types changed
```

If validation fails, fix and retry. If unfixable, note the failure.

## Step 7: Merge Back (Fan In)

Return to the parent branch and merge each unit sequentially:

```bash
git checkout "$PARENT_BRANCH"

for UNIT_BRANCH in fan-out-unit-1 fan-out-unit-2 ...; do
    git merge "$UNIT_BRANCH" --no-edit
    # Run validation after each merge
    bun run lint && bun run build && bun test
done
```

Merge order: if any units were sequenced due to shared files, merge them in order.

If a merge conflict occurs:
1. Identify conflicting files
2. Resolve (agent's work takes priority for files in its scope)
3. Validate after resolution
4. Commit the merge

## Step 8: Clean Up

```bash
# Remove worktrees and branches for succeeded units
for N in 1 2 3 ...; do
    git worktree remove "../worktree-unit-N" 2>/dev/null
    git branch -d "fan-out-unit-N" 2>/dev/null
done
```

Preserve worktrees for failed units so they can be inspected.

## Step 9: Final Validation and Report

```bash
# Full validation suite on merged result
bun run lint && bun run build && bun test
```

Report:
```
Fan-Out-Fan-In Complete
Units completed: 4/5
Units failed: 1 (Unit 3: validation failed)
Merged: Unit 1, 2, 4, 5
Final validation: PASSED
```

## Safety Rules

- Never force push.
- Never modify the parent branch until fan-in phase.
- Always validate after each merge.
- Preserve failed worktrees for inspection.
- Clean up succeeded worktrees automatically.
- If the parent branch moved during execution, rebase before merging.
