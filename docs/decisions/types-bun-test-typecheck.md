# @types/bun for the test/ type-check

Status: accepted for #11787 (type-check `test/` behind a per-file count baseline).

Dependency: `@types/bun`

## Decision

`tsconfig.test.json` type-checks `test/**/*.ts` (and `tsconfig.json` loads the same types for src, which imports `bun:sqlite`); tests import `bun:test` and use the `Bun`
global. Those declarations ship in `@types/bun` (which pulls `bun-types`). It is a
devDependency only, pinned to the Bun release line the repo uses (runtime `1.4.4`; `@types/bun`
tracks the newest published `1.4.x`), and is never part of the published runtime graph.

## Alternatives checked

| Alternative                         | Why not                                                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Built-in TypeScript / Node typings  | `@types/node` has no `bun:test` module or `Bun` global, so every test file would error.                                |
| An existing direct dependency       | None of the installed packages declare `bun:test`.                                                                     |
| Hand-written ambient declarations   | Would drift from Bun's real API and need maintenance for every `bun:test` matcher; `@types/bun` is the maintained set. |
| Leave `test/` out of the type-check | That is the gap #11787 closes: test-only type errors were invisible to CI.                                             |
