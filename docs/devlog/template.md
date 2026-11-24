# Devlog entry template

Copy this file to `docs/devlog/YYYY-MM-DD-<slug>.md`, where the date is when the decision or text
was first recorded. Then run `bun scripts/docs/generate-devlog-index.ts`: it lists the entry in the
[devlog index](index.md) and the `mkdocs.yml` "Devlog" nav, newest first, from its title, kind and
date. Do not edit either list by hand.

```markdown
# <Title in sentence case>

- Kind: decision | concept | idea
- Date: YYYY-MM-DD
- Source: <issue or PR, or the page the text moved from>
- Shaped: [<page title>](../how-it-works/<path>.md)

## Context

What problem or constraint prompted this.

## Options

The alternatives that were checked. Write "Not recorded." when the source lists none.

## Decision

What was chosen.

## Consequences

What this commits the code and docs to.
```

Decision records use the four sections above. Concept and idea entries use whatever sections fit.
Every entry cites its source; do not reconstruct history the source does not state. A new direct
dependency's record also carries a `Dependency: \`<name>\``line, which`bun run check:stdlib-first`
looks for.
