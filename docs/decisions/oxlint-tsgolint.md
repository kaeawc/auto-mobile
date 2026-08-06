# Why this dependency is needed

- Dependency: `oxlint-tsgolint` (oxlint's type-aware backend, built on the
  TypeScript-7 `tsgo` engine).
- Standard-library and existing-helper alternatives considered: the two
  type-aware rules the repo enforces — `no-floating-promises` and
  `no-misused-promises` — require full type information, which no syntactic linter
  rule, standard-library facility, or existing repo helper can provide. Under the
  old toolchain they came from `@typescript-eslint` (removed with ESLint).
- Why those alternatives do not meet the requirement: base `oxlint` cannot run
  type-aware rules on its own; it needs a type engine. `oxlint-tsgolint` is that
  engine, and it reuses the same TypeScript-7 compiler and `tsconfig.json` as the
  `tsgo` type-check gate, so there is one source of type truth rather than two.
  Dropping the rules was considered and rejected: they guard a real,
  previously-shipped bug class (fire-and-forget promises), and `tsgolint` in fact
  surfaces more of them than `@typescript-eslint` did.
- Runtime, bundle, security, and maintenance impact: dev-only dependency
  (`devDependencies`, an optional peer of `oxlint`), never shipped in the
  published package or the runtime bundle. It is a preview/alpha component pinned
  to a dated version aligned with the `tsgo` build; treat version bumps together
  with `@typescript/native-preview`.
- Usage: activated by `--type-aware`, which only `scripts/oxlint-baseline.sh`
  passes (so the main `oxlint --fix` stays fast and CI type-checks once). The two
  promise rules are `warn` and gated by that ratchet. See
  `typescript-native-preview.md`, `oxlint.md`.
