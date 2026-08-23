# Why this dependency is needed

- Dependency: `@typescript/native-preview` (the `tsgo` binary — the TypeScript 7
  native compiler preview).
- Standard-library and existing-helper alternatives considered: the prior
  toolchain used `typescript` (`tsc`) for the scoped `--noEmit` type-check gate
  (`scripts/typecheck-baseline.sh`). Bun's bundler does the actual build and does
  NOT type-check, so a standalone type-checker is required; there is no
  standard-library or existing-helper substitute for full-program TypeScript type
  analysis.
- Why those alternatives do not meet the requirement: staying on `tsc` is the
  status quo we are deliberately migrating off. `tsgo` is materially faster on a
  repo this size and, more importantly, is the same TypeScript-7 engine that
  `oxlint-tsgolint` uses for oxlint's type-aware rules — so the type-check gate
  and the lint type-aware rules share one compiler and one `tsconfig.json`
  (`module: ESNext` + `moduleResolution: bundler`) instead of drifting. TS7 also
  removed `moduleResolution: node10`, which the repo had to migrate off regardless.
- Runtime, bundle, security, and maintenance impact: dev-only dependency
  (`devDependencies`), never shipped in the published package or the runtime
  bundle. It is a **preview** build pinned to an exact dated version
  (`7.0.0-dev.YYYYMMDD.N`); diagnostics can shift between dated snapshots, so the
  typecheck baseline records its generator version (`# generated-with:` header)
  and the gate warns on drift. Bumps must pair the version change with
  `bun run typecheck:update` in the same PR.
- Usage: consumed only by `scripts/typecheck-baseline.sh` (`bunx tsgo --noEmit -p
tsconfig.json`) as the CI type-check gate, and transitively by
  `oxlint --type-aware`. See `oxlint.md`, `oxlint-tsgolint.md`.
