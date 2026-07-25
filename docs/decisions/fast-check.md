# Why this dependency is needed

- Dependency: `fast-check`
- Standard-library and existing-helper alternatives considered: Node/Bun expose
  no randomized-input-generation or shrinking primitive. The repo's `Random`
  seam (`src/utils/Random.ts`) produces individual values for production code but
  has no arbitrary combinators, no automatic minimization of a failing case, and
  no seeded run reporting — the machinery property-based testing depends on.
  Hand-rolling generators plus a shrinker in `test/` would reimplement the core
  of `fast-check` with far less coverage and no maintenance.
- Why those alternatives do not meet the requirement: property-based testing
  needs (1) composable arbitraries, (2) shrinking to a minimal counterexample,
  and (3) reproducible seeded runs. None exist in the standard library or an
  existing project helper, and each is substantial to build correctly.
- Runtime, bundle, security, and maintenance impact: dev-only dependency
  (`devDependencies`), so it never ships in the published package or affects the
  runtime bundle size. `fast-check` has zero runtime dependencies, is actively
  maintained, and is the de-facto TypeScript standard for property testing.
- Test strategy: consumed exclusively by co-located `*.property.test.ts` suites
  running under `bun test`. Each suite pins a seed so generated cases are
  deterministic in CI, matching the repo convention of injecting randomness
  rather than relying on ambient entropy; on failure `fast-check` prints the seed
  and the shrunk counterexample for reproduction.
