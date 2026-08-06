# Why this dependency is needed

- Dependency: `oxlint` (the Oxc linter), with a custom JS plugin at
  `oxlint-plugins/auto-mobile.mjs`.
- Standard-library and existing-helper alternatives considered: the prior
  toolchain used `eslint` plus `@typescript-eslint/*`, `@stylistic/eslint-plugin`,
  and `eslint-plugin-import`. Linting a TypeScript codebase against custom AST
  rules is not something the standard library or an existing repo helper provides.
- Why those alternatives do not meet the requirement: ESLint is the status quo we
  are migrating off. oxlint runs the same rule set far faster and consolidates the
  four ESLint packages into one. The repo's custom rules
  (`catch-convention`, `no-unknown-cast`, `no-accumulator-foreach`,
  `no-bare-expect`, `stress-explicit-timeout`, plus ports of the
  `no-restricted-syntax` / `naming-convention` selectors) are carried by an
  oxlint JS plugin, whose authoring API (`create(context)` → visitor,
  `context.report`, `meta.messages`) is ESLint-compatible, so the rule logic
  ports 1:1.
- Runtime, bundle, security, and maintenance impact: dev-only dependency
  (`devDependencies`), never shipped in the published package or the runtime
  bundle. The native binary is delivered per-platform via optional
  `@oxlint/binding-*` packages. oxlint's custom-JS-plugin API (`jsPlugins`) is
  marked **alpha and not subject to semver**, so the `.oxlintrc.json` plugin
  contract may need revisiting on bumps.
- Gaps handled elsewhere: oxlint has no bulk-suppressions file (ESLint's
  `eslint-suppressions.json`) — the count-based ratchet is rebuilt as
  `scripts/oxlint-baseline.sh`; and oxlint is not a formatter — see `oxfmt.md`.
- Usage: `bun run lint` runs `oxlint --fix` then the ratchet gate. Custom rules
  are unit-tested via an in-process harness (`test/lint/oxlintRuleHarness.ts`,
  built on `oxc-parser`) because oxlint's own `RuleTester` requires Node's
  raw-transfer bridge and does not run under bun.
