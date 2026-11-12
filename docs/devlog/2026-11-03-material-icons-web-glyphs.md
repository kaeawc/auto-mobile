# Material Icons SVG package for prototype web icon glyphs

- Kind: decision
- Date: 2026-11-03
- Source: moved from `docs/decisions/material-icons-web-glyphs.md` (added in #16608)

Status: accepted for #16532 (part of the prototype web renderer epic #16525). The iOS skin's glyph
set is decided separately in #16526.

Dependency: `@material-design-icons/svg` (Apache-2.0), a runtime dependency pinned to an exact
version.

## Decision

In an Android frame the prototype web still draws each icon with the Material Icons glyph Compose
draws: the contract's `iconName` list is a curated 300-name subset of `material-icons-extended`, and this
package ships the same icons as one 24 x 24 SVG per name in the filled, outlined, round, sharp and
two-tone styles. A server-only reader, which the page builder injects into the still renderer
so the renderer keeps no Node builtins for its browser bundle (#16451), reads one file per glyph
drawn (through `import.meta.resolve`, so
nothing is bundled and the release roots derivation pins the package), parses it with `xml2js`
(already used in `src/`) into the shapes it allows, and caches it. A page therefore carries only
the glyphs it draws. A retained name without a package glyph (a deprecated Compose-only icon) keeps
the placeholder with reason `iconMissing`.

## Alternatives checked

| Alternative                                             | Why not                                                                                                                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendored glyph JSON in `src/`                           | About 3 MB of path data for five styles, bundled into `dist` and churned on every icon refresh; the package keeps it out of the bundle and is about 800 KB compressed. |
| Material Symbols font (`material-symbols`)              | A variable font, not path data: a page would inline the whole font or subset it at export time, and Android draws Material Icons, not Symbols.                         |
| `@mui/icons-material`                                   | MIT and the same glyphs, but as React components; reading paths out of them needs a JS evaluation step and pulls React types.                                          |
| Reading Compose's `material-icons-extended` vector data | Kotlin sources inside an Android artifact; no TypeScript-readable form without a Gradle step.                                                                          |
