# Devlog entry template

Copy this file to `docs/devlog/YYYY-MM-DD-<slug>.md`, where the date is when the decision or text
was first recorded. Add the entry to `mkdocs.yml` under "Devlog" and to the
[devlog index](index.md), newest first.

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
