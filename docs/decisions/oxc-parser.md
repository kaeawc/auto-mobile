# Why this dependency is needed

- Dependency: `oxc-parser` (the Oxc JavaScript/TypeScript parser).
- Standard-library and existing-helper alternatives considered: the custom oxlint
  rules need unit tests, but oxlint's own `RuleTester` (`oxlint/plugins-dev`)
  relies on Node's raw-transfer AST bridge and throws under bun ("not supported
  ... on other runtimes"), and this repo's test runner is bun. Driving a rule's
  visitor in-process requires an ESTree AST of the code snippet; neither the
  standard library nor an existing repo helper parses TypeScript to ESTree.
- Why those alternatives do not meet the requirement: `RuleTester` cannot run
  under bun; a hand-rolled TypeScript parser is infeasible. `oxc-parser` is the
  parser oxlint itself is built on, so the AST the rule harness
  (`test/lint/oxlintRuleHarness.ts`) feeds a rule matches what the oxlint runtime
  feeds it. It was already present transitively; declaring it as a direct,
  pinned devDependency stops a routine change in another tool's tree from
  breaking these tests at module resolution or silently shifting the AST version.
- Runtime, bundle, security, and maintenance impact: dev-only dependency
  (`devDependencies`), never shipped in the published package or the runtime
  bundle. Pinned to an exact version so the AST shape the harness relies on moves
  only deliberately, alongside the oxlint toolchain. Native parsing is delivered
  per-platform via `@oxc-parser/binding-*`.
- Usage: imported only by `test/lint/oxlintRuleHarness.ts`, which parses a code
  snippet to ESTree and walks it to exercise a single custom rule's visitor. See
  `oxlint.md`.
