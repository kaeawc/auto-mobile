# Why this dependency is needed

- Dependency: `oxfmt` (the Oxc formatter).
- Standard-library and existing-helper alternatives considered: the prior
  toolchain enforced formatting through ~30 ESLint stylistic rules
  (`indent`, `quotes`, `semi`, the `*-spacing` family, `brace-style`, etc.) run
  with `--fix`. When ESLint is removed those rules go with it. There is no
  standard-library or existing-helper formatter.
- Why those alternatives do not meet the requirement: `oxlint` deliberately
  implements **no** stylistic rules — the Oxc project separates linting from
  formatting — so replacing ESLint's linting with oxlint leaves formatting
  unenforced. `oxfmt` is Oxc's own formatter and the natural companion; keeping it
  in-ecosystem avoids a second toolchain (e.g. Prettier + its Node dependency) and
  its defaults (2-space, double-quote, semicolons) already match this repo's
  established style.
- Runtime, bundle, security, and maintenance impact: dev-only dependency
  (`devDependencies`), never shipped in the published package or the runtime
  bundle. It is pre-1.0 and opinionated (Prettier-style), so its first run
  reformats a large share of the tree; that one-time reformat is deliberately kept
  to its own commit and `format:check` is not yet wired into `lint`/CI until that
  lands.
- Usage: `bun run format` writes, `bun run format:check` checks. Config in
  `.oxfmtrc.json`. See `oxlint.md` for why linting and formatting are split.
