# Standard library first

Before adding a package or introducing a generic helper, first look for the
JavaScript/Node standard-library API and existing code under `src/utils/`.
AutoMobile favors small domain helpers over a general utility dependency, and
it keeps time, randomness, I/O, concurrency, and process access behind an
interface when a fake is needed for fast unit tests.

## Decision order

1. Use the standard library when it expresses the required behavior clearly.
2. Reuse an existing AutoMobile helper or interface when it preserves an
   established policy or test seam.
3. Add a focused local helper only when neither option captures the required
   domain behavior.
4. Add a dependency only when the behavior is substantial, maintained, and
   cannot be safely expressed by the preceding choices.

Do not bypass existing `Timer`, `Random`, `IdGenerator`, retry, cache,
filesystem, process, or download seams from production code. Inject the
interface and use the corresponding fake in unit tests.

`Map.groupBy()` is appropriate only when all records are already materialized.
For streaming or incrementally assembled results, retain the project helper
that appends to a `Map` bucket. Before adopting a newly available runtime API,
verify it on the minimum Bun version declared in `package.json`, not merely the
developer's local runtime.

## Dependency decisions

Every new dependency declared in `dependencies`, `devDependencies`, or
`optionalDependencies` must have a short Markdown record in
`docs/decisions/`. Include this exact field so `bun run check:stdlib-first` can
verify it:

```md
# Why this dependency is needed

- Dependency: `package-name`
- Standard-library and existing-helper alternatives considered:
- Why those alternatives do not meet the requirement:
- Runtime, bundle, security, and maintenance impact:
- Test strategy:
```

The check intentionally does not try to infer whether two implementations are
semantically equivalent. Use review for that judgment; lint only bans the
high-confidence cases (`Math.random()` in production and direct Lodash imports).
