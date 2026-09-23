# Docs browser assets

TypeScript sources for the browser JavaScript served by the MkDocs
documentation site. The repo requires TypeScript for authored code
(`AGENTS.md`/`CLAUDE.md`), so these assets are written here and the
browser-ready `.js` is generated rather than hand-edited.

| Source (`docs-assets/src`) | Generated output (`docs/assets/javascripts`) | Used on                                                                   |
| -------------------------- | -------------------------------------------- | ------------------------------------------------------------------------- |
| `usage-data.ts`            | `usage-data.js`                              | `docs/metrics/usage-data.md` — download charts in `#dl-metrics`           |
| `prompt-form.ts`           | `prompt-form.js`                             | `docs/using/agent-examples.md` — copyable-prompt UI and live placeholders |

Both outputs are referenced from `mkdocs.yml` via `extra_javascript`.

## Regenerating

```bash
bun scripts/docs/build-docs-assets.ts          # rebuild the .js
bun scripts/docs/build-docs-assets.ts --check   # CI gate: fail if the .js is stale
```

The build:

1. Type-checks the sources against `docs-assets/tsconfig.json` (DOM-scoped, kept
   separate from the root `tsconfig.json` so browser globals never leak into
   `src/` or the typecheck baseline). Bun's bundler transpiles without checking
   types, so this `tsgo` pass is the type gate.
2. Bundles each entry to a browser IIFE with Bun's built-in bundler.
3. Formats the result with `oxfmt` and prepends a `@generated` banner.

The generated files are **checked in**. `--check` runs in Fast Validation
(`scripts/all_fast_validate_checks.sh`, the `docs-assets` check) and rejects a
hand-edit of the generated `.js` or a source change that was not rebuilt. Edit
the TypeScript, run the build, and commit both.

## Why no build step in the deploy path (dependency-decision note)

This introduces **no new dependency**: Bun and `oxfmt` are already the repo's
toolchain, so the stdlib-first rule (`scripts/check-stdlib-first.sh`) needs no
decision record.

The GitHub Pages deploy (`scripts/github/deploy_pages.py`,
`.github/workflows/docs.yml`) runs on a Python/`uv` toolchain with **no Bun**.
Rather than add Bun to that path (a heavier, riskier change to the publish
pipeline), the committed `.js` is the source of truth for the deploy, and the
Fast Validation `--check` gate — which runs in the Bun-equipped Node lane —
guarantees it is never stale. `docs_changed_since_last_deploy.sh` lists
`docs-assets` and `scripts/docs` so a source-or-generator change still triggers a
republish.
